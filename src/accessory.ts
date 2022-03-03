import { PlatformAccessory, PlatformConfig } from 'homebridge'
import { AirconService } from "./accessories/aircon"
import { DehumidifierService } from "./accessories/dehumidifier"
import { EVENT_UPDATED, Device } from './accessories/device'
import { FanService } from "./accessories/fan"
import { OutdoorTemperatureService } from "./accessories/outdoor"
import { MitsubishiHeavyAirconPlatform } from './platform'


const MANUFACTURER = "Mitsubishi Heavy Industries"

/**
 * Homebridge accessory class containing indoor aircon related services
 */
export class AirconAccessory {

    private aircon: AirconService
    private fan: FanService
    private dehumidifier: DehumidifierService

    constructor(
        device: Device,
        platform: MitsubishiHeavyAirconPlatform,
        accessory: PlatformAccessory,
        config: PlatformConfig,
    ) {
        const Characteristic = platform.Characteristic
        platform.log.debug("1. construct accessory")

        device.on(EVENT_UPDATED, this.updateHomeBridgeState.bind(this))
        platform.log.debug("2. add event")

        const MODEL = device.MODEL
        platform.log.debug("3. device model")

        // set accessory information
        const service = accessory.getService(platform.Service.AccessoryInformation)
        platform.log.debug("4. get service")
        if (service) {
            service
                .setCharacteristic(Characteristic.Identify, false)
                .setCharacteristic(Characteristic.Manufacturer, MANUFACTURER)
                .setCharacteristic(Characteristic.Model, MODEL)
                .setCharacteristic(Characteristic.SerialNumber, config.info.sn)
                .setCharacteristic(Characteristic.FirmwareRevision, config.info.fwVersion)
            platform.log.debug("5. set service")
        }

        // Add the relavant accessories
        this.aircon = new AirconService(platform, accessory, device)
        platform.log.debug("6. new aircon")
        this.fan = new FanService(platform, accessory, device)
        platform.log.debug("7. new fan")
        this.dehumidifier = new DehumidifierService(platform, accessory, device)
        platform.log.debug("7. new humid")
    }

    async updateHomeBridgeState(): Promise<void> {
        console.log("Updated called! :)")
        this.aircon.updateHomeBridgeState()
        this.fan.updateHomeBridgeState()
        this.dehumidifier.updateHomeBridgeState()
    }
}


/**
 * Homebridge accessory class containing outdoor aircon related services
 */
export class OutdoorTemperatureAccessory {

    private temperature: OutdoorTemperatureService

    constructor(
        device: Device,
        platform: MitsubishiHeavyAirconPlatform,
        accessory: PlatformAccessory,
        config: PlatformConfig,
    ) {
        const Characteristic = platform.Characteristic
        device.on(EVENT_UPDATED, this.updateHomeBridgeState.bind(this))
        
        const MODEL = device.MODEL

        // set accessory information
        const service = accessory.getService(platform.Service.AccessoryInformation)
        if (service) {
            service
                .setCharacteristic(Characteristic.Name, 'Outdoor')
                .setCharacteristic(Characteristic.Identify, false)
                .setCharacteristic(Characteristic.Manufacturer, MANUFACTURER)
                .setCharacteristic(Characteristic.Model, MODEL)
                .setCharacteristic(Characteristic.SerialNumber, config.info.sn)
                .setCharacteristic(Characteristic.FirmwareRevision, config.info.fwVersion)
        }

        this.temperature = new OutdoorTemperatureService(platform, accessory, device)
    }

    async updateHomeBridgeState(): Promise<void> {
        this.temperature.updateHomeBridgeState()
    }
}
