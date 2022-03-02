import { EventEmitter } from 'events';
import { Logger } from 'homebridge';
import net from 'net';
import * as http from 'http';
import { SensorType, EVENT_CHANGED, EVENT_UPDATED, SensorConfigMap, Device } from './device';

type CommandResponseType = any;         // eslint-disable-line @typescript-eslint/no-explicit-any

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

    private sessionID = ""
    private syncTimeout: NodeJS.Timeout | null = null

    private sensorMap: any = {}             // eslint-disable-line @typescript-eslint/no-explicit-any
    private previousState: any = {}         // eslint-disable-line @typescript-eslint/no-explicit-any
    private state: any = {}                 // eslint-disable-line @typescript-eslint/no-explicit-any

    private coms: MHRCWMP1_connect
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private identity: any = {}

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
            this.setState('active', value);
        },
        fanSpeed: async (value: number): Promise<void> => {
            this.setState('fanSpeed', value);
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
            this.setState('setpoint', value);
        },
        swingMode: async (value: number): Promise<void> => {
            if (value) {
                this.setState('verticalPosition', 10);
            } else {
                this.setState('verticalPosition', 4);
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
     * Requests hardware configuration information from the device
     *
     * @returns Object containing device information such as firmware version
     */
    public async getInfo(): Promise<Record<string, string>> {
        //const result = await this.httpRequest("getinfo", {})
        this.log.debug("identity ",this.identity)
        return JSON.parse(this.identity)
    }

    /**
     * Performs login with the device
     *
     * @returns Session ID if login is successful
     */
    public async login(): Promise<string> {
        const result = await this.httpRequest("login", { username: this.username, password: this.password })
        this.sessionID = result.id.sessionID
        this.previousState = {}
        this.state = {}
        return result.id.sessionID
    }

    /**
     * Performs device logout
     */
    public async logout(): Promise<void> {
        await this.httpRequest("logout");
        this.resetState()
    }

    /**
     * Returns the services that are currently available
     *
     * @returns List of service commands available on device
     */
    public async getAvailableServices(): Promise<string[]> {
        const result = await this.httpRequest("getavailableservices")
        return result.userinfo.servicelist
    }

    /**
     * Returns the services that are currently available
     *
     * @returns List of service commands available on device
     */
    public async getAvailableDatapoints(): Promise<Record<string, unknown>> {
        const result = await this.httpRequest("getavailabledatapoints")
        return result.dp.datapoints
    }

    /**
     * Queries all sensors on the device
     *
     * After the device query, the returned values are normalized into the
     * "state" object variable.
     *
     */
    public async refreshState(): Promise<void>  {
        const result = await this.httpRequest("getdatapointvalue", { uid: "all" })
        this.parseState(result.dpval)
    }

    /**
     * Reads all sensors values from the device and caches them into the `state` variable.
     */
    private async syncState() {
        if (!this.sessionID) {
            this.log.debug('Logging in to obtain a session ID')
            await this.login()
                .then(() => {
                    this.log.debug('Obtained a new session ID')
                })
                .catch(error => {
                    this.log.error('Unable to authenticate', error)
                    this.resetState()
                })
            if (this.sessionID) {
                await this.getAvailableServices()
                    .then((result) => {
                        this.log.debug(`Available services: ${JSON.stringify(result)}`)
                    })
                    .catch(error => {
                        this.log.error('Unable to get available services', error)
                        this.resetState()
                    })

                await this.getAvailableDatapoints()
                    .then((result) => {
                        this.log.debug(`Available datapoints: ${JSON.stringify(result)}`)
                    })
                    .catch(error => {
                        this.log.error('Unable to get available services', error)
                        this.resetState()
                    })

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
        }

        let syncPeriod = this.syncPeriod

        if (this.sessionID) {
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
        } else {
            // Not logged in. slow down the polling
            syncPeriod = 30000
        }

        this.syncTimeout = setTimeout(async () => { this.syncState() }, syncPeriod)
    }

    /**
     * Clears all state information and sessionID
     */
    private resetState(): void {
        this.sessionID = "";
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
        await this.httpRequest("setdatapointvalue", { uid: map.uid, value: xvalue });
        this.state[attr] = value;
        this.checkForChange()
    }

    /**
     * Sends an HTTP POST request to the device with the given command
     *
     * This function takes care of adding sessionID credentials to the request
     * from current login.  Returned result is the "data" field in the
     * response json payload.
     *
     * @param command   Command for the request
     * @param data      Parameters associated with the command
     * @returns         JSON data returned by the device
     */
    private httpRequest(command: string, data: Record<string, unknown> = {}) {
        if (command != "getdatapointvalue") {
            // Log before adding credentials
            this.log.debug(`httpRequest: ${command} ${JSON.stringify(data)}`)
        }
        data['sessionID'] = this.sessionID
        const payload = JSON.stringify({ command: command, data: data })

        const options = {
            hostname: this.host,
            path: "/api.cgi",
            method: "POST",
            headers: {
                "Content-Length": payload.length,
                "Content-Type": "application/json"
            }
        }

        return new Promise<CommandResponseType>((resolve, reject) => {
            const req = http.request(options, (res) => {
                if (res.statusCode != 200) {
                    this.log.debug(`Received http error code ${res.statusCode} for ${command}`)
                    reject({ code: res.statusCode, message: "Invalid HTTP response" })
                }

                const buffer: string[] = []
                res.on("data", (chunk: string) => buffer.push(chunk));
                res.on("end", () => {
                    const content = buffer.join("").toString()
                    const result = JSON.parse(content)
                    if (result.success) {
                        resolve(result.data)
                    } else {
                        this.log.debug(`Received http error response: ${content}`)
                        reject(result)
                    }
                });
            });

            req.on("error", (error) => {
                this.log.error(`Http request error: ${error}`)
                reject(error)
            });
            req.write(payload)
            req.end()
        });
    }

    /**
     * Converts the SensorCOnfigMap into a two-way translation structure for converting
     * uid <-> attrName and human-values <-> machine-values.
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
        this.log.debug("id recieved: ",id)
        const [model, wlanSTAMAC, ip, protocol, fwVersion, rssi, name] = id.split(",");
        this.identity = {model, wlanSTAMAC, ip, protocol, fwVersion, rssi, name};
        this.identity.sn = wlanSTAMAC
      }


}

class MHRCWMP1_connect extends EventEmitter {

    static instance: MHRCWMP1_connect
    private number = 1
    socket;
    buffer: string;

    private constructor(private log: Logger, private host: string){
        super()
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
        this.sendGET("*");
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
            this.log.debug("Received unknown message:", code, rest);
        }
    }

    private onSocketError = (error) => {
        this.log.error("Connection error:", error);
    }

    private onSocketClose = () => {
        this.log.warn("Connection closed, reconnecting in 5 seconds");
        setTimeout(() => {
            this.connect();
        }, 5000);
    }

    private send(command) {
        this.log.debug("Send:", command);
        this.socket.write(command + "\r\n");
    }
    
    private sendID() {
        this.send("ID");
    }
    
    private sendINFO(callback) {
        if (callback) {
          this.once("INFO", function(value) { callback(null, value) });
        }
        this.send("INFO");
    }
    
    private sendGET(name) {
        this.send("GET," + this.number + ":" + name);
    }

}