import {
  API,
  DynamicPlatformPlugin,
  Logging,
  MatterAccessory,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { EufyRobovacAccessory } from './accessory';
import { EufyRobovacMatterAccessory } from './matter-accessory';
import { ConsoleLogger, Logger } from './consoleLogger';

export class EufyRobovacPlatform implements DynamicPlatformPlugin {
  public readonly log: Logger;
  public readonly config: PlatformConfig;
  public readonly api: API;

  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached HAP accessories
  public readonly accessories: PlatformAccessory[] = [];

  // this is used to track restored cached Matter accessories
  public readonly matterAccessories: Map<string, MatterAccessory> = new Map();

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.log = config.debugLogEnabled ? new ConsoleLogger(0, 'homebridge-eufy-robovac:') : log;
    this.config = config;
    this.api = api;

    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;

    this.log.debug('Finished initializing platform:', this.config.name);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      // run the method to discover / register your devices as accessories
      this.discoverDevices();
    });
  }

  /**
   * This function is invoked when homebridge restores cached HAP accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  /**
   * This function is invoked when homebridge restores cached Matter accessories from disk at startup.
   */
  configureMatterAccessory(accessory: MatterAccessory) {
    this.log.info('Loading Matter accessory from cache:', accessory.displayName);
    this.matterAccessories.set(accessory.UUID, accessory);
  }

  /**
   * Register discovered accessories via Matter (native Robotic Vacuum Cleaner on Homebridge 2.0+)
   * or fall back to legacy HAP accessories when Matter is unavailable/disabled.
   */
  discoverDevices() {
    if (!Array.isArray(this.config.devices) || this.config.devices.length === 0) {
      this.log.warn('No Eufy RoboVac devices configured.');
      return;
    }

    const useMatter = Boolean(
      this.api.isMatterAvailable?.() && this.api.isMatterEnabled?.() && this.api.matter,
    );

    if (useMatter) {
      this.discoverMatterDevices().catch((err) => {
        this.log.error('Error registering Matter vacuum accessories:', err);
      });
    } else {
      this.discoverHapDevices();
    }
  }

  private async discoverMatterDevices(): Promise<void> {
    if (!this.api.matter) {
      return;
    }

    // Remove any cached legacy HAP Fan/Switch accessories so the vacuum is only exposed once as a native Matter vacuum
    if (this.accessories.length > 0) {
      this.log.info(
        `Matter is enabled; removing ${this.accessories.length} cached legacy HAP accessory/accessories.`,
      );
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [...this.accessories]);
      this.accessories.length = 0;
    }

    const activeMatterUuids = new Set<string>();

    for (const deviceConfig of this.config.devices) {
      const matterVacuum = new EufyRobovacMatterAccessory(this, deviceConfig, this.log);
      activeMatterUuids.add(matterVacuum.uuid);

      if (this.matterAccessories.has(matterVacuum.uuid)) {
        this.log.info('Restoring existing Matter vacuum accessory from cache:', deviceConfig.name);
      } else {
        this.log.info('Adding new Matter vacuum accessory:', deviceConfig.name);
      }

      await this.api.matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
        matterVacuum.accessory,
      ]);
      await matterVacuum.onRegistered();
      this.matterAccessories.set(matterVacuum.uuid, matterVacuum.accessory);
    }

    // Unregister any cached Matter accessories that were removed from config.devices
    for (const [uuid, cachedAccessory] of this.matterAccessories.entries()) {
      if (!activeMatterUuids.has(uuid)) {
        this.log.info('Removing stale Matter accessory from cache:', cachedAccessory.displayName);
        await this.api.matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
          cachedAccessory,
        ]);
        this.matterAccessories.delete(uuid);
      }
    }
  }

  private discoverHapDevices(): void {
    // loop over the configured devices and register each one if it has not already been registered
    for (const deviceConfig of this.config.devices) {
      // generate a unique id for the accessory this should be generated from
      // something globally unique, but constant, for example, the device serial
      // number or MAC address
      const uuid = this.api.hap.uuid.generate(deviceConfig.deviceId);

      // see if an accessory with the same uuid has already been registered and restored from
      // the cached devices we stored in the `configureAccessory` method above
      const existingAccessory = this.accessories.find((accessory) => accessory.UUID === uuid);

      if (existingAccessory) {
        // the accessory already exists
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

        // create the accessory handler for the restored accessory
        new EufyRobovacAccessory(this, existingAccessory, deviceConfig, this.log);
      } else {
        // the accessory does not yet exist, so we need to create it
        this.log.info('Adding new accessory:', deviceConfig.name);

        // create a new accessory
        const accessory = new this.api.platformAccessory(deviceConfig.name, uuid);

        // store a copy of the device object in the `accessory.context`
        // the `context` property can be used to store any data about the accessory you may need
        accessory.context.device = deviceConfig;

        // create the accessory handler for the newly create accessory
        new EufyRobovacAccessory(this, accessory, deviceConfig, this.log);

        // link the accessory to your platform
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }
}
