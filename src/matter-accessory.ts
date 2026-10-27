import { MatterAccessory } from 'homebridge';

import { EufyRobovacPlatform } from './platform';
import {
  CleanSpeed,
  ErrorCode,
  RoboVac,
  StatusDps,
  StatusResponse,
  WorkMode,
  WorkStatus,
  getErrorCodeFriendlyName,
  statusDpsFriendlyNames,
} from './robovac-api';
import { Logger } from './consoleLogger';

/**
 * Matter RvcRunMode mode values and tags (Matter 1.4 spec / @matter/types RvcRunMode)
 */
export enum RvcRunModeValue {
  Idle = 0,
  Cleaning = 1,
}

export enum RvcRunModeTag {
  Idle = 16384, // 0x4000
  Cleaning = 16385, // 0x4001
}

/**
 * Matter RvcCleanMode mode values and tags (Matter 1.4 spec / @matter/types RvcCleanMode)
 */
export enum RvcCleanModeValue {
  Quiet = 0,
  Auto = 1,
  Max = 2,
}

export enum RvcCleanModeTag {
  Auto = 0,
  Quiet = 2,
  Max = 7,
  Vacuum = 16385, // 0x4001
}

export const SUPPORTED_CLEAN_MODES = [
  {
    label: 'Quiet',
    mode: RvcCleanModeValue.Quiet,
    modeTags: [{ value: RvcCleanModeTag.Vacuum }, { value: RvcCleanModeTag.Quiet }],
  },
  {
    label: 'Auto',
    mode: RvcCleanModeValue.Auto,
    modeTags: [{ value: RvcCleanModeTag.Vacuum }, { value: RvcCleanModeTag.Auto }],
  },
  {
    label: 'Max',
    mode: RvcCleanModeValue.Max,
    modeTags: [{ value: RvcCleanModeTag.Vacuum }, { value: RvcCleanModeTag.Max }],
  },
];

/**
 * Matter RvcOperationalState enum values (Matter 1.4 spec / @matter/types RvcOperationalState)
 */
export enum RvcOperationalStateValue {
  Stopped = 0,
  Running = 1,
  Paused = 2,
  Error = 3,
  SeekingCharger = 64, // 0x40
  Charging = 65, // 0x41
  Docked = 66, // 0x42
}

/**
 * Matter RvcOperationalState ErrorState enum values
 */
export enum RvcErrorStateValue {
  NoError = 0,
  UnableToStartOrResume = 1,
  UnableToCompleteOperation = 2,
  CommandInvalidInState = 3,
  FailedToFindChargingDock = 64,
  Stuck = 65,
  LowBattery = 72,
  WheelsJammed = 76,
  BrushJammed = 77,
  NavigationSensorObscured = 78,
}

/**
 * Matter PowerSource cluster battery enum values
 */
export enum PowerSourceStatusValue {
  Unspecified = 0,
  Active = 1,
  Standby = 2,
  Unavailable = 3,
}

export enum BatChargeLevelValue {
  Ok = 0,
  Warning = 1,
  Critical = 2,
}

export enum BatChargeStateValue {
  Unknown = 0,
  IsCharging = 1,
  IsAtFullCharge = 2,
  IsNotCharging = 3,
}

export enum BatReplaceabilityValue {
  Unspecified = 0,
  NotReplaceable = 1,
  UserReplaceable = 2,
  FactoryReplaceable = 3,
}

export class EufyRobovacMatterAccessory {
  public readonly accessory: MatterAccessory;
  public readonly uuid: string;

  private readonly platform: EufyRobovacPlatform;
  private readonly roboVac: RoboVac;
  private readonly log: Logger;
  private readonly name: string;
  private readonly connectionConfig: { deviceId: string; localKey: string; deviceIp: string };

  private readonly callbackTimeout = 3000;
  private readonly cachingDuration = 60000;
  private readonly criticalBatteryThreshold = 10;
  private readonly warningBatteryThreshold = 20;
  private readonly identifyResetTimeoutMs = 10000;

  private isRegistered = false;
  private pendingStatus: StatusResponse | null = null;
  private identifyTimeout?: ReturnType<typeof setTimeout>;

  constructor(platform: EufyRobovacPlatform, config: any, log: Logger) {
    this.platform = platform;
    this.log = log;
    this.name = config.name;
    this.connectionConfig = {
      deviceId: config.deviceId,
      localKey: config.localKey,
      deviceIp: config.deviceIp,
    };

    if (!this.platform.api.matter) {
      throw new Error('Matter API is not available on this Homebridge instance');
    }

    this.uuid = this.platform.api.matter.uuid.generate(config.deviceId);
    this.log.debug(`Initializing EufyRobovacMatterAccessory for ${this.name} (UUID: ${this.uuid})...`);

    this.accessory = {
      UUID: this.uuid,
      displayName: this.name,
      deviceType: this.platform.api.matter.deviceTypes.RoboticVacuumCleaner,
      serialNumber: config.deviceId,
      manufacturer: 'Eufy',
      model: 'RoboVac',
      firmwareRevision: '1.0.0',
      hardwareRevision: '1.0.0',
      context: {
        device: config,
      },
      clusters: {
        identify: {
          identifyTime: 0,
          identifyType: 4, // AudibleBeep
        },
        rvcRunMode: {
          supportedModes: [
            {
              label: 'Idle',
              mode: RvcRunModeValue.Idle,
              modeTags: [{ value: RvcRunModeTag.Idle }],
            },
            {
              label: 'Cleaning',
              mode: RvcRunModeValue.Cleaning,
              modeTags: [{ value: RvcRunModeTag.Cleaning }],
            },
          ],
          currentMode: RvcRunModeValue.Idle,
        },
        rvcCleanMode: {
          supportedModes: SUPPORTED_CLEAN_MODES,
          currentMode: RvcCleanModeValue.Auto,
        },
        rvcOperationalState: {
          operationalStateList: [
            { operationalStateId: RvcOperationalStateValue.Stopped },
            { operationalStateId: RvcOperationalStateValue.Running },
            { operationalStateId: RvcOperationalStateValue.Paused },
            { operationalStateId: RvcOperationalStateValue.Error },
            { operationalStateId: RvcOperationalStateValue.SeekingCharger },
            { operationalStateId: RvcOperationalStateValue.Charging },
            { operationalStateId: RvcOperationalStateValue.Docked },
          ],
          operationalState: RvcOperationalStateValue.Docked,
          operationalError: {
            errorStateId: RvcErrorStateValue.NoError,
          },
        },
        powerSource: {
          status: PowerSourceStatusValue.Active,
          order: 0,
          description: 'Primary Battery',
          batPercentRemaining: 200,
          batChargeLevel: BatChargeLevelValue.Ok,
          batReplacementNeeded: false,
          batReplaceability: BatReplaceabilityValue.NotReplaceable,
          batChargeState: BatChargeStateValue.IsAtFullCharge,
          batFunctionalWhileCharging: false,
        },
      },
      handlers: {
        identify: {
          identify: this.handleIdentify.bind(this),
        },
        rvcRunMode: {
          changeToMode: this.handleChangeRunMode.bind(this),
        },
        rvcCleanMode: {
          changeToMode: this.handleChangeCleanMode.bind(this),
        },
        rvcOperationalState: {
          pause: this.handlePause.bind(this),
          resume: this.handleResume.bind(this),
          goHome: this.handleGoHome.bind(this),
        },
      },
    };

    this.roboVac = new RoboVac(
      this.connectionConfig,
      this.updateCharacteristics.bind(this),
      this.cachingDuration,
      this.log,
    );

    this.log.info('Finished initializing Matter vacuum accessory:', this.name);
  }

  private initialDefaultModeApplied = false;

  /**
   * Called by the platform after the accessory has been registered with Homebridge Matter API.
   * Flushes any status updates that arrived while registration was in progress.
   */
  async onRegistered(): Promise<void> {
    this.isRegistered = true;
    await this.updateClusterState('rvcCleanMode', {
      supportedModes: SUPPORTED_CLEAN_MODES,
      currentMode: RvcCleanModeValue.Auto,
    });
    if (this.pendingStatus) {
      const pending = this.pendingStatus;
      this.pendingStatus = null;
      await this.applyStatusUpdate(pending);
    }
  }

  /**
   * Reset the vacuum clean speed to Standard (Auto) so the Home app tile defaults to "Auto".
   */
  private resetToDefaultAutoMode(): void {
    if (this.roboVac.getCleanSpeedCached() !== CleanSpeed.STANDARD) {
      this.roboVac.setCleanSpeed(CleanSpeed.STANDARD).catch((err) => {
        this.log.debug(`Failed to reset default Auto clean mode for ${this.name}:`, err);
      });
    }
    this.updateClusterState('rvcCleanMode', {
      currentMode: RvcCleanModeValue.Auto,
    }).catch((err) => {
      this.log.debug(`Failed to update rvcCleanMode to Auto for ${this.name}:`, err);
    });
  }

  /**
   * Handle Matter `rvcRunMode.changeToMode` command.
   */
  private async handleChangeRunMode(request: { newMode: number }): Promise<void> {
    const newMode = request?.newMode;
    this.log.debug(`Matter rvcRunMode.changeToMode for ${this.name}: newMode=${newMode}`);

    if (newMode === RvcRunModeValue.Cleaning) {
      await this.withTimeout(this.roboVac.setWorkMode(WorkMode.AUTO));
      await this.updateClusterState('rvcOperationalState', {
        operationalState: RvcOperationalStateValue.Running,
      });
    } else {
      if (this.roboVac.getRunningCached() === false) {
        this.log.debug(
          `rvcRunMode.changeToMode(Idle) for ${this.name} received, but device is already idle according to cache`,
        );
        return;
      }
      await this.withTimeout(this.roboVac.setGoHome(true));
      await this.updateClusterState('rvcOperationalState', {
        operationalState: RvcOperationalStateValue.SeekingCharger,
      });
      this.resetToDefaultAutoMode();
    }
  }

  /**
   * Handle Matter `rvcCleanMode.changeToMode` command.
   */
  private async handleChangeCleanMode(request: { newMode: number }): Promise<void> {
    const newMode = request?.newMode;
    this.log.debug(`Matter rvcCleanMode.changeToMode for ${this.name}: newMode=${newMode}`);

    const cleanSpeed = this.cleanModeToCleanSpeed(newMode);
    if (this.roboVac.getCleanSpeedCached() === cleanSpeed) {
      this.log.debug(
        `rvcCleanMode.changeToMode(${cleanSpeed}) for ${this.name} received, but clean speed is already ${cleanSpeed}`,
      );
      return;
    }
    await this.withTimeout(this.roboVac.setCleanSpeed(cleanSpeed));
  }

  /**
   * Handle Matter `rvcOperationalState.pause` command.
   */
  private async handlePause(): Promise<void> {
    this.log.debug(`Matter rvcOperationalState.pause for ${this.name}`);
    await this.withTimeout(this.roboVac.setPlayPause(false));
    await this.updateClusterState('rvcOperationalState', {
      operationalState: RvcOperationalStateValue.Paused,
    });
  }

  /**
   * Handle Matter `rvcOperationalState.resume` command.
   */
  private async handleResume(): Promise<void> {
    this.log.debug(`Matter rvcOperationalState.resume for ${this.name}`);
    await this.withTimeout(this.roboVac.setWorkMode(WorkMode.AUTO));
    await this.updateClusterState('rvcRunMode', {
      currentMode: RvcRunModeValue.Cleaning,
    });
    await this.updateClusterState('rvcOperationalState', {
      operationalState: RvcOperationalStateValue.Running,
    });
  }

  /**
   * Handle Matter `rvcOperationalState.goHome` command.
   */
  private async handleGoHome(): Promise<void> {
    this.log.debug(`Matter rvcOperationalState.goHome for ${this.name}`);
    await this.withTimeout(this.roboVac.setGoHome(true));
    await this.updateClusterState('rvcRunMode', {
      currentMode: RvcRunModeValue.Idle,
    });
    await this.updateClusterState('rvcOperationalState', {
      operationalState: RvcOperationalStateValue.SeekingCharger,
    });
    this.resetToDefaultAutoMode();
  }

  /**
   * Handle Matter `identify.identify` command (triggers Eufy Find Robot beep).
   */
  private async handleIdentify(request?: { identifyTime?: number }): Promise<void> {
    this.log.info(`Triggered Matter Identify (Find Robot) for ${this.name}:`, request?.identifyTime);
    await this.withTimeout(this.roboVac.setFindRobot(true));

    if (this.identifyTimeout) {
      clearTimeout(this.identifyTimeout);
    }
    this.identifyTimeout = setTimeout(() => {
      this.roboVac.setFindRobot(false).catch((err) => {
        this.log.debug(`Failed to reset Find Robot for ${this.name}:`, err);
      });
    }, this.identifyResetTimeoutMs);
    if (typeof this.identifyTimeout.unref === 'function') {
      this.identifyTimeout.unref();
    }
  }

  /**
   * Callback invoked by `RoboVac` whenever DPS updates are received from the vacuum.
   */
  updateCharacteristics(statusResponse: StatusResponse): void {
    this.log.debug(`updateCharacteristics (Matter) for ${this.name}`);
    if (!statusResponse || !statusResponse.dps) {
      return;
    }

    if (!this.isRegistered) {
      if (!this.pendingStatus) {
        this.pendingStatus = {
          devId: statusResponse.devId,
          dps: { ...statusResponse.dps },
        };
      } else {
        Object.assign(this.pendingStatus.dps, statusResponse.dps);
      }
      return;
    }

    this.applyStatusUpdate(statusResponse).catch((err) => {
      this.log.error(`Failed to update Matter state for ${this.name}:`, err);
    });
  }

  private async applyStatusUpdate(statusResponse: StatusResponse): Promise<void> {
    const dps = statusResponse.dps;
    let counter = 0;

    // 1. Clean Speed -> rvcCleanMode
    if (dps[StatusDps.CLEAN_SPEED] !== undefined) {
      if (!this.initialDefaultModeApplied) {
        this.initialDefaultModeApplied = true;
        this.resetToDefaultAutoMode();
        counter++;
      } else {
        const cleanSpeed = dps[StatusDps.CLEAN_SPEED] as CleanSpeed;
        const mode = this.cleanSpeedToCleanMode(cleanSpeed);
        if (mode !== null) {
          this.log.debug(
            `updating ${statusDpsFriendlyNames.get(StatusDps.CLEAN_SPEED)} for ${this.name} to ${cleanSpeed} (mode=${mode})`,
          );
          await this.updateClusterState('rvcCleanMode', { currentMode: mode });
          counter++;
        }
      }
    }

    // 2. Battery Level & Work Status -> powerSource
    const powerSourcePatch: Record<string, unknown> = {};
    if (dps[StatusDps.BATTERY_LEVEL] !== undefined && dps[StatusDps.BATTERY_LEVEL]! >= 0) {
      const batteryLevel = dps[StatusDps.BATTERY_LEVEL]!;
      this.log.debug(
        `updating ${statusDpsFriendlyNames.get(StatusDps.BATTERY_LEVEL)} for ${this.name} to ${batteryLevel}%`,
      );
      powerSourcePatch.batPercentRemaining = Math.min(200, Math.max(0, Math.round(batteryLevel * 2)));
      powerSourcePatch.batChargeLevel = this.batteryLevelToChargeLevel(batteryLevel);
    }

    if (dps[StatusDps.WORK_STATUS] !== undefined) {
      const workStatus = dps[StatusDps.WORK_STATUS] as WorkStatus;
      powerSourcePatch.batChargeState = this.workStatusToBatChargeState(workStatus);
    }

    if (Object.keys(powerSourcePatch).length > 0) {
      await this.updateClusterState('powerSource', powerSourcePatch);
      counter++;
    }

    // 3. Running, Work Status, Go Home & Error Code -> rvcRunMode & rvcOperationalState
    const hasRunOrStateUpdate =
      dps[StatusDps.RUNNING] !== undefined ||
      dps[StatusDps.WORK_STATUS] !== undefined ||
      dps[StatusDps.GO_HOME] !== undefined ||
      dps[StatusDps.ERROR_CODE] !== undefined;

    if (hasRunOrStateUpdate) {
      const effectiveErrorCode =
        dps[StatusDps.ERROR_CODE] !== undefined
          ? dps[StatusDps.ERROR_CODE]
          : this.roboVac.getErrorCodeCached();
      const hasActiveError = !this.isNoError(effectiveErrorCode);

      const { runMode, operationalState } = this.resolveRunAndOperationalState(dps, hasActiveError);

      if (runMode !== null) {
        await this.updateClusterState('rvcRunMode', { currentMode: runMode });
        counter++;
      }

      const operationalPatch: Record<string, unknown> = {};
      if (operationalState !== null) {
        operationalPatch.operationalState = operationalState;
      }

      if (dps[StatusDps.ERROR_CODE] !== undefined) {
        if (hasActiveError && effectiveErrorCode !== null && effectiveErrorCode !== undefined) {
          const friendlyError = getErrorCodeFriendlyName(effectiveErrorCode);
          this.log.info(`${this.name} reported a device error: ${friendlyError}`);
          operationalPatch.operationalError = {
            errorStateId: this.errorCodeToMatterErrorStateId(effectiveErrorCode),
            errorStateDetails: friendlyError,
          };
        } else {
          operationalPatch.operationalError = {
            errorStateId: RvcErrorStateValue.NoError,
          };
        }
      }

      if (Object.keys(operationalPatch).length > 0) {
        await this.updateClusterState('rvcOperationalState', operationalPatch);
        counter++;
      }
    }

    this.log.debug(`updateCharacteristics (Matter) for ${this.name} complete - updated ${counter} cluster(s).`);
  }

  private isNoError(errorCode: unknown): boolean {
    return (
      errorCode === null ||
      errorCode === undefined ||
      errorCode === ErrorCode.NO_ERROR ||
      errorCode === 0 ||
      errorCode === '0' ||
      errorCode === '' ||
      errorCode === 'default - invalid'
    );
  }

  private resolveRunAndOperationalState(
    dps: StatusResponse['dps'],
    hasActiveError: boolean,
  ): { runMode: RvcRunModeValue | null; operationalState: RvcOperationalStateValue | null } {
    let runMode: RvcRunModeValue | null = null;
    let operationalState: RvcOperationalStateValue | null = null;

    if (dps[StatusDps.WORK_STATUS] !== undefined) {
      const workStatus = dps[StatusDps.WORK_STATUS] as WorkStatus;
      switch (workStatus) {
        case WorkStatus.RUNNING:
          runMode = RvcRunModeValue.Cleaning;
          operationalState = RvcOperationalStateValue.Running;
          break;
        case WorkStatus.RECHARGE_NEEDED:
          runMode = RvcRunModeValue.Idle;
          operationalState = RvcOperationalStateValue.SeekingCharger;
          break;
        case WorkStatus.CHARGING:
          runMode = RvcRunModeValue.Idle;
          operationalState = RvcOperationalStateValue.Charging;
          break;
        case WorkStatus.CHARGING_COMPLETED:
          runMode = RvcRunModeValue.Idle;
          operationalState = RvcOperationalStateValue.Docked;
          break;
        case WorkStatus.STAND_BY:
        case WorkStatus.SLEEPING:
          runMode = RvcRunModeValue.Idle;
          operationalState = RvcOperationalStateValue.Paused;
          break;
      }
    } else if (dps[StatusDps.RUNNING] !== undefined) {
      if (dps[StatusDps.RUNNING]) {
        runMode = RvcRunModeValue.Cleaning;
        operationalState = RvcOperationalStateValue.Running;
      } else {
        runMode = RvcRunModeValue.Idle;
        const goHome = dps[StatusDps.GO_HOME] ?? this.roboVac.getGoHomeCached();
        const cachedWorkStatus = this.roboVac.getWorkStatusCached();
        if (goHome || cachedWorkStatus === WorkStatus.RECHARGE_NEEDED) {
          operationalState = RvcOperationalStateValue.SeekingCharger;
        } else if (cachedWorkStatus === WorkStatus.CHARGING) {
          operationalState = RvcOperationalStateValue.Charging;
        } else if (cachedWorkStatus === WorkStatus.CHARGING_COMPLETED) {
          operationalState = RvcOperationalStateValue.Docked;
        } else {
          operationalState = RvcOperationalStateValue.Paused;
        }
      }
    } else if (dps[StatusDps.GO_HOME] === true) {
      runMode = RvcRunModeValue.Idle;
      operationalState = RvcOperationalStateValue.SeekingCharger;
    }

    if (hasActiveError) {
      runMode = RvcRunModeValue.Idle;
      operationalState = RvcOperationalStateValue.Error;
    } else if (
      dps[StatusDps.ERROR_CODE] !== undefined &&
      this.isNoError(dps[StatusDps.ERROR_CODE]) &&
      operationalState === null
    ) {
      // Error was cleared without a concurrent workStatus/running field in the same packet;
      // restore operationalState from cached status
      const cachedWorkStatus = this.roboVac.getWorkStatusCached();
      const cachedRunning = this.roboVac.getRunningCached();
      if (cachedRunning) {
        runMode = RvcRunModeValue.Cleaning;
        operationalState = RvcOperationalStateValue.Running;
      } else if (cachedWorkStatus === WorkStatus.CHARGING) {
        runMode = RvcRunModeValue.Idle;
        operationalState = RvcOperationalStateValue.Charging;
      } else if (cachedWorkStatus === WorkStatus.CHARGING_COMPLETED) {
        runMode = RvcRunModeValue.Idle;
        operationalState = RvcOperationalStateValue.Docked;
      } else if (cachedWorkStatus === WorkStatus.RECHARGE_NEEDED) {
        runMode = RvcRunModeValue.Idle;
        operationalState = RvcOperationalStateValue.SeekingCharger;
      } else {
        runMode = RvcRunModeValue.Idle;
        operationalState = RvcOperationalStateValue.Paused;
      }
    }

    return { runMode, operationalState };
  }

  public cleanModeToCleanSpeed(mode: number): CleanSpeed {
    switch (mode) {
      case RvcCleanModeValue.Quiet:
        return CleanSpeed.QUIET;
      case RvcCleanModeValue.Auto:
        return CleanSpeed.STANDARD;
      case RvcCleanModeValue.Max:
        return CleanSpeed.MAX;
      default:
        return CleanSpeed.STANDARD;
    }
  }

  public cleanSpeedToCleanMode(cleanSpeed: CleanSpeed | string): RvcCleanModeValue | null {
    switch (cleanSpeed) {
      case CleanSpeed.QUIET:
        return RvcCleanModeValue.Quiet;
      case CleanSpeed.STANDARD:
      case CleanSpeed.BOOST_IQ:
        return RvcCleanModeValue.Auto;
      case CleanSpeed.TURBO:
      case CleanSpeed.MAX:
        return RvcCleanModeValue.Max;
      default:
        return null;
    }
  }

  public batteryLevelToChargeLevel(batteryLevel: number): BatChargeLevelValue {
    if (batteryLevel <= this.criticalBatteryThreshold) {
      return BatChargeLevelValue.Critical;
    }
    if (batteryLevel <= this.warningBatteryThreshold) {
      return BatChargeLevelValue.Warning;
    }
    return BatChargeLevelValue.Ok;
  }

  public workStatusToBatChargeState(workStatus: WorkStatus): BatChargeStateValue {
    switch (workStatus) {
      case WorkStatus.CHARGING:
        return BatChargeStateValue.IsCharging;
      case WorkStatus.CHARGING_COMPLETED:
        return BatChargeStateValue.IsAtFullCharge;
      default:
        return BatChargeStateValue.IsNotCharging;
    }
  }

  public errorCodeToMatterErrorStateId(errorCode: string | number): RvcErrorStateValue {
    switch (String(errorCode)) {
      case ErrorCode.NO_ERROR:
      case '0':
        return RvcErrorStateValue.NoError;
      case ErrorCode.STUCK_5_MIN:
      case ErrorCode.CRASH_BAR_STUCK:
        return RvcErrorStateValue.Stuck;
      case ErrorCode.WHEEL_STUCK:
        return RvcErrorStateValue.WheelsJammed;
      case ErrorCode.S_BRUSH_STUCK:
      case ErrorCode.R_BRUSH_STUCK:
        return RvcErrorStateValue.BrushJammed;
      case ErrorCode.SENSOR_DIRTY:
        return RvcErrorStateValue.NavigationSensorObscured;
      case ErrorCode.NOT_ENOUGH_POWER:
        return RvcErrorStateValue.LowBattery;
      case ErrorCode.FAN_STUCK:
      default:
        return RvcErrorStateValue.UnableToCompleteOperation;
    }
  }

  private async updateClusterState(cluster: string, attributes: Record<string, unknown>): Promise<void> {
    if (!this.isRegistered || !this.platform.api.matter) {
      return;
    }
    await this.platform.api.matter.updateAccessoryState(this.uuid, cluster as any, attributes as any);
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        setTimeout(() => reject(new Error('Request timed out')), this.callbackTimeout);
      }),
    ]);
  }
}
