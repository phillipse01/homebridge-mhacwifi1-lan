import { EventEmitter } from 'events';
import { Logger } from 'homebridge';
import net from 'net';
import { SensorType, EVENT_CHANGED, EVENT_UPDATED, Device } from './device';

/**
 * Hardware interface class for the MH-RC-WMP-1
 *
 * This class provides local WMP access to the Intesis WIFI control board used
 * in the Mitsubishi Heavy Aircon.
 *
 * If enabled (via the `startSynchronization` method), the object periodically
 * polls all of the device's sensors and reflects those back in the `state`
 * property of the class.  When sensors change values, the object will emit
 * an `update` event to notify listeners that at least one value in the state
 * has changed.  For specific changes, listeners can monitor the `changed`
 * event for the specific state that changed.
 *
 * The aircon status should be obtained through the `get` API such as obj.get.active()
 * or obj.get.currentTemperature().  To control the aircon, you use the `set`
 * API such as obj.set.active(1) or object.setFanSpeed(2).
 */
export class MHRCWMP1 extends EventEmitter implements Device {

    public  MODEL = "MH-RC-WMP-1"
    private isInitialSynced = false
    private syncTimeout: NodeJS.Timeout | null = null

    private sensorMap: any = {}             // eslint-disable-line @typescript-eslint/no-explicit-any
    private previousState: any = {}         // eslint-disable-line @typescript-eslint/no-explicit-any
    private state: any = {}                 // eslint-disable-line @typescript-eslint/no-explicit-any

    private coms: MHRCWMP1_connect
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private identity: any = {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private info: any;

    constructor(
        private log: Logger,
        private host: string,                            // IP or hostname
        private username: string,                        // Username used for authentication
        private password: string,                        // Password used for authentication
        private slowThreshold: number = 500,             // Number of milliseconds before reporting a slow connection
        private minSetpoint: number = 18,                // Minimum value for the setpoint temperature
        private maxSetpoint: number = 30,                // Maximum value for the setpoint temperature
        private syncPeriod: number = 1000,               // Number of milliseconds between sensor sync requests
        ) {
        super();
        this.minSetpoint = Math.max(18, minSetpoint)
        this.state.minSetpoint = this.minSetpoint
        this.log.info(`Minimum setpoint is ${this.minSetpoint}`)
        this.maxSetpoint = Math.min(30, maxSetpoint)
        this.state.maxSetpoint = this.maxSetpoint
        this.log.info(`Minimum setpoint is ${this.maxSetpoint}`)
        this.slowThreshold = slowThreshold || 500
        this.log.info(`Slow device threshold is ${this.slowThreshold}ms`)
        this.syncPeriod = Math.max(1000, syncPeriod)
        this.log.info(`Device sync period is ${this.syncPeriod}ms`)
        this._buildSensorMap();
        this.log.info(`You have selected WMP communication`)
        //create connaection singleton:
        this.coms = MHRCWMP1_connect.getInstance(this.log,this.host)
        //listen for event info from the connection
        this.coms.on("ID", this.onID);
        this.coms.on("INFO", this.onINFO);
        this.coms.on("CHN,1", this.onCHN);
    }

    /**
     * Public API for getting state values
     */
    public get = {
        active: (): number => this.state.active,
        currentTemperature: (): number => this.state.currentTemperature,
        fanSpeed: (): number => this.state.fanSpeed,
        locked: (): number => this.state.remoteDisable,
        maxSetpoint: (): number => this.state.maxSetpoint,
        minSetpoint: (): number => this.state.minSetpoint,
        mode: (): number => this.state.mode,
        outdoorTemperature: (): number => this.state.outdoorTemperature,
        setpoint: (): number => this.state.setpoint,
        swingMode: (): number => (this.state.verticalPosition == 10) ? 1 : 0,
        valid: (): boolean => typeof this.state.active !== "undefined",
    };

    /**
     * Public API for setting state values
     *
     */
    public set = {
        active: async (value: number): Promise<void> => {
            this.setState('onoff', value);
        },
        fanSpeed: async (value: number): Promise<void> => {
            this.setState('fansp', value);
        },
        locked: async (value: number): Promise<void> => {
            this.setState('remoteDisable', value);
        },
        maxSetpoint: async (value: number): Promise<void> => {
            this.setState('maxSetpoint', value);
        },
        minSetpoint: async (value: number): Promise<void> => {
            this.setState('minSetpoint', value);
        },
        mode: async (value: number): Promise<void> => {
            this.setState('mode', value);
        },
        setpoint: async (value: number): Promise<void> => {
            this.setState('setptemp', value);
        },
        swingMode: async (value: number): Promise<void> => {
            if (value) {
                this.setState('vaneud', 10);
            } else {
                this.setState('vaneud', 4);
            }
        }
    }

    /**
     * Enables periodic timer for polling all device sensor states
     */
    public startSynchronization(): void {
        setImmediate(() => { this.syncState() });
    }

    /**
     * Stops the periodic polling for sensor states
     */
    public stopSynchronization(): void {
        if (this.syncTimeout)
            clearTimeout(this.syncTimeout);
        this.syncTimeout = null;
    }

    /**
     * Requests hardware configuration information from the device. Specifically:
     * model, wlanSTAMAC, ip, protocol, fwVersion, rssi, name, sn
     *
     * @returns Object containing device information such as firmware version
     */
    public async getInfo(): Promise<Record<string, string>> {
        if (this.identity.length == 0) {
            try {
                await this.waitForEvent(this, "onIDUpd");
            } catch (ex) {
                console.log("async ID update failed with ", ex);
            }
        }
        return this.identity
    }

    /**
     * Queries all sensors on the device
     *
     * After the device query, the returned values are normalized into the
     * "state" object variable.
     *
     */
    public async refreshState(): Promise<void>  {
        // force all sensor data
        this.coms.sendGET("*");
        try {
            await this.waitForEvent(this, "onCHNUpd");
        } catch (ex) {
            console.log("async CHN full update failed with ", ex);
        }
    }

    /**
     * Reads all sensors values from the device and caches them into the `state` variable.
     */
    private async syncState() {
        if (!this.isInitialSynced) {
            this.log.debug('Initial sync started')
            //reset some variables
            this.previousState = {}
            this.state = {}
            this.isInitialSynced = true
            this.state.minSetpoint = this.minSetpoint
            this.state.maxSetpoint = this.maxSetpoint

            // Set sane defaults
            await this.set.minSetpoint(this.minSetpoint)
                .catch(error => {
                    this.log.error('Unable to get set minSetpoint value', error)
                })
            await this.set.maxSetpoint(this.maxSetpoint)
                .catch(error => {
                    this.log.error('Unable to get set maxSetpoint value', error)
                })
        }

        const syncPeriod = this.syncPeriod

        // this.log.debug('Refreshing state')
        const start = Date.now()
        await this.refreshState()
            .then(() => {
                const query_time = Date.now() - start;
                if (query_time > this.slowThreshold) {
                    this.log.warn(`Slow response time from ${this.host} query time ${query_time}ms`);
                }
                this.checkForChange()
            })
            .catch(error => {
                this.log.error('Unable to refresh state', error);
                this.resetState()
        });

        this.syncTimeout = setTimeout(async () => { this.syncState() }, syncPeriod)
    }

    /**
     * Clears all state information and sessionID
     */
    private resetState(): void {
        this.isInitialSynced = false;
        this.previousState = {}
        this.state = {}
    }

    /**
     * Converts the raw sensor data into normalized state values
     *
     * @param states
     */
    private parseState(sensors: SensorType[]): void {
        sensors.forEach(item => {
            const map = this.sensorMap[item.uid];
            if (!map) {
                this.log.error('Unhandled sensor item', item);
                return;
            }
            if (!map.attr) {
                return;
            }
            this.state[map.attr] = map.xform ? map.xform(item.value) : item.value;
        });
        this.checkForChange()
    }

    /**
     * Checks previous and current state for differences and emits signal on difference
     *
     * Emits a EVENT_CHANGED event for each changed property with property name, old
     * value, and new value.  Emits a generic EVENT_UPDATED property if any property
     * values have changed.
     */
    private checkForChange() {
        let changed = false;
        Object.keys(this.state).forEach((attr) => {
            if (this.state[attr] != this.previousState[attr]) {
                changed = true
                this.log.info(`State change for ${attr}  ${this.previousState[attr]} => ${this.state[attr]}`)
                this.emit(EVENT_CHANGED, attr, this.previousState[attr], this.state[attr])
                this.previousState[attr] = this.state[attr]
            }
        })
        if (changed) {
            setTimeout(() => { this.emit(EVENT_UPDATED); }, 0)
        }
    }

    /**
     * Sets the given sensor to the given value
     *
     * @param attr  Attribute name
     * @param value Normalized value (will be mapped into device specific value)
     */
    private async setState(attr: string, value: number) {
        const map = this.sensorMap[attr];
        const xvalue = map.xform ? map.xform(value) : value
        this.log.debug(`setState attr=${attr}, uid=${map.uid}, value=${xvalue}`);
        let command: string
        if(attr == "maxSetpoint") {
            const map2 = this.sensorMap["minSetpoint"];
            const xvalue2 = map2.xform ? map2.xform(this.state.minSetpoint) : this.state.minSetpoint
            command = `LIMITS:SETPTEMP,[${xvalue2},${xvalue}]`
        } else if (attr == "minSetpoint") {
            const map2 = this.sensorMap["maxSetpoint"];
            const xvalue2 = map2.xform ? map2.xform(this.state.maxSetpoint) : this.state.maxSetpoint
            command = `LIMITS:SETPTEMP,[${xvalue},${xvalue2}]`
        } else {
            command = `SET,1:${attr},${value}`
        }
        this.coms.send(command)

        try {
            await this.waitForEvent(this.coms, "ACK");
        } catch (ex) {
            console.log(`async setState failed to confim change ack on comand ${command} with`, ex);
        }
        //this.state[attr] = value; doing a set returns with a CHN confirmation - not needed
        //this.checkForChange()
    }

    /**
     * Converts the SensorCOnfigMap into a two-way translation structure for converting
     * uid <-> attrName and human-values <-> machine-values.
     * 
     * The object sensormap has two sections. Accessing sensorMap[sensor.uid] is for 
     * getting the human value from machine (fromVal), while accessing sensorMap[sensor.uid] 
     * is for getting machine values from human (toVal).
     */
    private _buildSensorMap() {
        SensorConfigMap.forEach(sensor => {
            const rev_values = {}
            for (const key in sensor.values) {
                rev_values[sensor.values[key]] = key
            }

            this.sensorMap[sensor.uid] = {
                attr: sensor.attr,
                values: sensor.values,
                xform: sensor.fromVal,
            };
            if (sensor.attr) {
                this.sensorMap[sensor.attr] = {
                    uid: sensor.uid,
                    values: rev_values,
                    xform: sensor.toVal,

                }
            }
        })

    }

    private onID = (id) => {
        //ID:Model,MAC,IP,Protocol,Version,RSSI,Name,(unknown)
        const [model, wlanSTAMAC, ip, protocol, fwVersion, rssi, name] = id.split(",");
        this.identity = {model, wlanSTAMAC, ip, protocol, fwVersion, rssi, name};
        this.identity.sn = wlanSTAMAC
        this.emit("onIDUpd")
    }

    private onINFO = (name, value) => {
        this.info[name] = value;
    }
    
    private onCHN = (name, value) => {
        this.log.debug("INCOMING STATE:")
        let chnData
        const id = this.sensorMap[name.toString().toLowerCase()].uid;
        chnData.uid = id;
        chnData.value = value;

        if (name == "ONOFF") {
          if (value == "ON" ) {
            this.log.debug("Device turned ON")
          } else if (value == "OFF") {
            this.log.debug("Device turned OFF")
          } else {
            this.log.warn("Unknown ONOFF value:", value)
          }
        } else if (name == "MODE") {
          if (value == "AUTO" ) {
            this.log.debug("Device set to AUTO mode")
          } else if (value == "HEAT") {
            this.log.debug("Device set to HEAT mode")
          } else if (value == "COOL") {
            this.log.debug("Device set to COOL mode")
          } else if (value == "FAN") {
            this.log.debug("Device set to FAN mode (unsupported in HomeKit)")
          } else if (value == "DRY") {
            this.log.debug("Device set to DRY mode (unsupported in HomeKit)")
          } else {
            this.log.warn("Device set to unknown mode:", value)
          }
        } else if (name == "SETPTEMP") {
          this.log.debug("Device target temperature set to:", value);
          this.log.debug("dosomething")
        } else if (name == "FANSP") {
          this.log.debug("Device fanspeed set to:", value);
        } else if (name == "VANEUD") {
          this.log.debug("Device vertical vane set to:", value);
        } else if (name == "VANELR") {
          return //not supported yet
          this.log.debug("Device horizontal vane set to:", value);
        } else if (name == "ERRSTATUS") {
          return //not supported yet
          this.log.debug("Device error status:", value);
        } else if (name == "ERRCODE") {
          return //not supported yet
          this.log.debug("Device error code:", value);
        } else if (name == "AMBTEMP") {
          this.log.debug("Device ambient temperature now:", value);
          this.log.debug("dosomething")
        }
        this.emit("onCHNUpd")
        this.parseState(chnData)
    }


    waitForEvent<T>(emitter: EventEmitter, event: string, timeoutMS = 10000): Promise<T> {
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error(`timeout waiting for event: ${event}`)) 
              }, timeoutMS)         

            const success = (val: T) => {
                emitter.off("error", fail);
                clearTimeout(timeoutId);
                resolve(val);
            };
            const fail = (err: Error) => {
                emitter.off(event, success);
                clearTimeout(timeoutId);
                reject(err);
            };
            emitter.once(event, success);
            emitter.once("error", fail);
        });
    }
}

/**
 * Hardware connection class for the MH-RC-WMP-1
 *
 * This singleton class handles all the direct communication with the 
 * WMP protocol. This is split out to be a singleton as the WMP intesis
 * devices has a MAXCONN of 2 - so we want to ensure there is only ever
 * one connection.
 * 
 * The WMP protocol also closes the connection after 1~2 minutes of no
 * commands recieved. We send a periodic PING command to ensure the 
 * socket stays open.
 * 
 * This class emits events when it recieves data can be listened and acted on:
 *  - ID: identify
 *  - INFO: info
 *  - ACK: Acknowledge command
 *  - CHN,1: Recieved change of state
 */
class MHRCWMP1_connect extends EventEmitter {

    static instance: MHRCWMP1_connect
    private number = 1
    socket;
    buffer: string;
    private timerId!: NodeJS.Timeout;

    private constructor(private log: Logger, private host: string){
        super()
        //this.timerId = setInterval(() => this.send("PING"), 50000)
        this.log.debug(`Created connect class`)
        this.buffer = "";
        this.connect();
    }

    public static getInstance(log: Logger, host: string): MHRCWMP1_connect {
        if (!MHRCWMP1_connect.instance) {
            MHRCWMP1_connect.instance = new MHRCWMP1_connect(log,host);
        }
        return MHRCWMP1_connect.instance;
    }

    public send(command) {
        this.log.debug("Send:", command);
        this.socket.write(command + "\r\n");
    }
    
    public sendID() {
        this.send("ID");
    }
    
    public sendINFO(callback) {
        if (callback) {
          this.once("INFO", function(value) { callback(null, value) });
        }
        this.send("INFO");
    }
    
    public sendGET(name) {
        this.send("GET," + this.number + ":" + name);
    }

    private connect() {
        this.log.info("Connecting to Intesis at "+this.host+":3310")
        this.socket = net.connect(3310, this.host, this.onSocketConnect);
        this.socket.on("error", this.onSocketError);
        this.socket.on("close", this.onSocketClose);
        this.socket.on("line", this.onSocketLine);
        this.socket.on("data", this.onSocketData);
    }

    private onSocketConnect = () => {
        // Ask for identifying information
        this.sendID();
    
        // Ask for the initial state
        //this.sendGET("*");

        //start ping to keep socket open
         this.timerId = setInterval(() => this.send("PING"), 50000);

    }

    private onSocketData = (data) => {
        this.buffer += data;
        let n = this.buffer.indexOf("\n");
        while (~n) {
          let line = this.buffer.substring(0, n);
          if (line.endsWith("\r")) {
            line = line.slice(0, -1);
          }
          this.socket.emit("line", line);
          this.buffer = this.buffer.substring(n + 1);
          n = this.buffer.indexOf("\n");
        }
      }
    
    private onSocketLine = (line) => {
        const [code, rest] = line.split(":", 2);
        if (code == "ID") {
            this.log.debug("Received identify:", rest)
            this.emit("ID", rest);
        } else if (code == "INFO") {
            const [name, value] = rest.split(",", 2);
            this.log.debug("Received info:", name, "=", value)
            this.emit("INFO", name, value);
        } else if (code == "ACK") {
            this.log.debug("Received ack")
            this.emit("ACK");
        } else if (code == "CHN," + this.number) {
            const [name, value] = rest.split(",", 2);

            this.log.debug("Received Change:", name, value)
            this.emit("CHN," + this.number, name, value);
            this.emit("CHN," + this.number + ":" + name, value);
        } else {
            this.log.warn("Received unknown message:", code, rest);
        }
    }

    private onSocketError = (error) => {
        this.log.error("Connection error:", error);
    }

    private onSocketClose = () => {
        this.log.warn("Connection closed, reconnecting in 5 seconds");
        clearInterval(this.timerId)
        setTimeout(() => {
            this.connect();
        }, 5000);
    }

}

const SensorConfigMap = [
    {
        uid: 1,
        attr: "onoff",
        values: {
            0: "off",
            1: "on",
        }
    },
    {
        uid: 2,
        attr: "mode",
        values: {
            "auto": 0,
            "heat": 1,
            "dry": 2,
            "fan": 3,
            "cool": 4,
        },
        toVal: (v: number) => { 
            switch(v){
                case 0: return "auto"
                case 1: return "heat"
                case 2: return "dry"
                case 3: return "fan"
                case 4: return "cool"
                default: return "auto"
            }
         },
        fromVal: (v: any) => {  // eslint-disable-line @typescript-eslint/no-explicit-any
            switch(v){
                case "auto": return 0
                case "heat": return 1
                case "dry": return 2
                case "fan": return 3
                case "cool": return 4
                default: return 0
            }
         }
    },
    {
        uid: 4,
        attr: "fansp",
        values: {
            "quiet": 1,
            "low": 2,
            "medium": 3,
            "high": 4,
        }
    },
    {
        uid: 5,
        attr: "vaneud",
        values: {
            "auto": 0,
            "pos-1": 1,
            "pos-2": 2,
            "pos-3": 3,
            "pos-4": 4,
            "pos-5": 5,
            "pos-6": 6,
            "pos-7": 7,
            "pos-8": 8,
            "pos-9": 9,
            "swing": 10,
            "swirl": 11,
            "wide": 12
        },
        toVal: (v: number) => { 
            if (v == 0) return "auto"
            if (v == 10) return "swing"
            return v
         },
        fromVal: (v: any) => {  // eslint-disable-line @typescript-eslint/no-explicit-any
            if (v == "auto") return 0
            if (v == "swing") return 10
            return v
         }
    },
    {
        uid: 9,
        attr: 'setptemp',
        fromVal: (v: number) => { if (v == 32768) { return 28; } else { return v / 10.0 } },
        toVal: (v: number) => { return v * 10.0 },
    },
    {
        uid: 10,
        attr: 'ambtemp',
        fromVal: (v: number) => { return v / 10.0 },
    },
    {
        uid: 12,
        attr: 'remoteDisable',
        values: {
            0: "off",
            1: "on",
        }
    },
    {
        uid: 13,
        attr: 'onTime',
        // Number of hours the unit has been on
    },
    {
        uid: 14,
        attr: 'alarmStatus',
        values: {
            0: "off",
            1: "on",
        }
    },
    {
        uid: 15,
        attr: 'errorCode',
        // Error status code
    },
    {
        uid: 34,
        attr: 'quietMode',
        values: {
            0: "off",
            1: "on",
        }
    },
    {
        uid: 35,
        attr: 'minSetpoint',
        toVal: (v: number) => { return v * 10.0 },
        fromVal: (v: number) => { return v / 10.0 },
    },
    {
        uid: 36,
        attr: 'maxSetpoint',
        toVal: (v: number) => { return v * 10.0 },
        fromVal: (v: number) => { return v / 10.0 },
    },
    {
        uid: 37,
        attr: 'outdoorTemperature',
        fromVal: (v: number) => { return v / 10.0 },
    },
    { uid: 181 },       // ignore this code
    { uid: 182 },       // ignore this code
    { uid: 183 },       // ignore this code
    { uid: 184 },       // ignore this code
]