import EventEmitter from "events";

export enum MhacModeTypes {
    AUTO = 0,
    HEAT = 1,
    DRY = 2,
    FAN = 3,
    COOL = 4,
}

export const EVENT_CHANGED = 'changed'
export const EVENT_UPDATED = 'updated'

type CommandResponseType = any;         // eslint-disable-line @typescript-eslint/no-explicit-any

export type SensorType = {
    uid: number
    value: number
}

export interface Device extends EventEmitter {

    /**
     * Public API for getting state values
     */
    get: any

    /**
     * Public API for setting state values
     *
     */
    set: any

     //set:{ minSetpoint: (arg0: number) => Promise<any>; maxSetpoint: (arg0: number) => Promise<any>; active: (arg0: number) => void; setpoint: (arg0: number) => void; locked: (arg0: number) => void; fanSpeed: (arg0: number) => void; swingMode: (arg0: number) => void; mode: (arg0: number) => void; }

    /**
     * Enables periodic timer for polling all device sensor states
     */
    startSynchronization(): void

    /**
     * Stops the periodic polling for sensor states
     */
    stopSynchronization(): void

    /**
     * Requests hardware configuration information from the device
     *
     * @returns Object containing device information such as firmware version
     */
    getInfo(): Promise<Record<string, string>>

    /**
     * Performs login with the device
     *
     * @returns Session ID if login is successful
     */
    login(): Promise<string>

    /**
     * Performs device logout
     */
    logout(): Promise<void>

    /**
     * Returns the services that are currently available
     *
     * @returns List of service commands available on device
     */
    getAvailableServices(): Promise<string[]>

    /**
     * Returns the services that are currently available
     *
     * @returns List of service commands available on device
     */
    getAvailableDatapoints(): Promise<Record<string, unknown>>

    /**
     * Queries all sensors on the device
     *
     * After the device query, the returned values are normalized into the
     * "state" object variable.
     *
     */
    refreshState(): Promise<void>
}

export const SensorConfigMap = [
    {
        uid: 1,
        attr: "active",
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
    },
    {
        uid: 4,
        attr: "fanSpeed",
        values: {
            "quiet": 1,
            "low": 2,
            "medium": 3,
            "high": 4,
        }
    },
    {
        uid: 5,
        attr: "verticalPosition",
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
        }
    },
    {
        uid: 9,
        attr: 'setpoint',
        fromVal: (v: number) => { if (v == 32768) { return 28; } else { return v / 10.0 } },
        toVal: (v: number) => { return v * 10.0 },
    },
    {
        uid: 10,
        attr: 'currentTemperature',
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