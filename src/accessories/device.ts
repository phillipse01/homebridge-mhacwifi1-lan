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

export type SensorType = {
    uid: number
    value: number
}

export interface Device extends EventEmitter {
    MODEL: string;

    /**
     * Public API for getting state values
     */
    get: {
        active: () => number,
        currentTemperature: () => number,
        fanSpeed: () => number,
        locked: () => number,
        maxSetpoint: () => number,
        minSetpoint: () => number,
        mode: () => number,
        outdoorTemperature: () => number,
        setpoint: () => number,
        swingMode: () => number,
        valid: () => boolean,
    }  

    /**
     * Public API for setting state values
     *
     */
    set: {
        active: (value: number) => Promise<void>,
        fanSpeed: (value: number) => Promise<void>,
        locked: (value: number) => Promise<void>,
        maxSetpoint: (value: number) => Promise<void>,
        minSetpoint: (value: number) => Promise<void>,
        mode: (value: number) => Promise<void>,
        setpoint: (value: number) => Promise<void>,
        swingMode: (value: number) => Promise<void>
    }
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
     * Queries all sensors on the device
     *
     * After the device query, the returned values are normalized into the
     * "state" object variable.
     *
     */
    refreshState(): Promise<void>
}