import Homey from 'homey';
import type { ThrottleTier } from '../../lib/SignalKConnectionPool';
import {
  resolveActiveServerId,
  resolveConnectionPool,
  resolveThrottleTier,
} from '../electrical-bank/M3DriverHelper';

export class DigitalSwitchDevice extends Homey.Device {
  private unsubs: Array<() => void> = [];
  private authUnsub: (() => void) | null = null;
  private serverId = 'default';
  private switchId = 'anchorLight';
  private basePath = 'electrical.switches.anchorLight';
  private hasDimSupport = false;

  public override async onInit(): Promise<void> {
    this.clearSubscriptions();

    const data = this.getData() || {};
    this.serverId = resolveActiveServerId(
      this.homey,
      this.getStoreValue('serverId') || data.serverId,
    );
    this.switchId = String(this.getStoreValue('switchId') || data.switchId || 'anchorLight');
    this.basePath = String(
      this.getStoreValue('basePath') || data.basePath || `electrical.switches.${this.switchId}`,
    );

    const storeHasDim = this.getStoreValue('hasDim');
    this.hasDimSupport =
      storeHasDim === true ||
      (storeHasDim === undefined && this.hasCapability('dim'));

    // Ensure capability list matches switch capabilities (remove dim if non-dimmable)
    if (!this.hasDimSupport && this.hasCapability('dim')) {
      await this.removeCapability('dim').catch(() => {});
    } else if (this.hasDimSupport && !this.hasCapability('dim')) {
      await this.addCapability('dim').catch(() => {});
    }

    this.registerCapabilityListeners();
    this.bindSubscriptions();
    this.bindAuthErrorListener();
  }

  private bindAuthErrorListener(): void {
    const pool = resolveConnectionPool(this.homey) as any;
    if (!pool) return;

    if (typeof pool.onAuthFailure === 'function') {
      this.authUnsub = pool.onAuthFailure(this.serverId, ({ message }: { message?: string }) => {
        this.setUnavailable(
          message || 'Authentication required — please use Repair Device to reconnect.',
        ).catch(() => {});
      });
    } else if (typeof pool.on === 'function') {
      const handler = ({ serverId, statusCode }: { serverId: string; statusCode?: number }) => {
        if (serverId === this.serverId) {
          this.setUnavailable(
            `Signal K authentication error (HTTP ${statusCode ?? 401}) — please use Repair Device.`,
          ).catch(() => {});
        }
      };
      pool.on('authError', handler);
      this.authUnsub = () => {
        if (typeof pool.off === 'function') {
          pool.off('authError', handler);
        } else if (typeof pool.removeListener === 'function') {
          pool.removeListener('authError', handler);
        }
      };
    }
  }

  private resolveSourceFilter(): string | undefined {
    const rawSetting = this.getSetting('sourceFilter');
    if (typeof rawSetting === 'string' && rawSetting.trim().length > 0) {
      return rawSetting.trim();
    }
    const rawStore = this.getStoreValue('sourceFilter');
    if (typeof rawStore === 'string' && rawStore.trim().length > 0) {
      return rawStore.trim();
    }
    return undefined;
  }

  private resolvePutTimeoutMs(): number {
    const raw = this.getSetting('putTimeoutMs');
    const num = Number(raw);
    if (Number.isFinite(num) && num >= 50) {
      return num;
    }
    return 5000;
  }

  private bindSubscriptions(): void {
    this.clearPathSubscriptions();

    const pool = resolveConnectionPool(this.homey);
    if (!pool) return;

    const settings = this.getSettings() || {};
    const tier: ThrottleTier = resolveThrottleTier(settings.throttleTier, 'fast');
    const sourceFilter = this.resolveSourceFilter();
    const subId = this.getData()?.id || `${this.serverId}::${this.basePath}`;

    this.unsubs.push(
      pool.subscribe(this.serverId, {
        subscriberId: subId,
        path: `${this.basePath}.state`,
        tier,
        sourceFilter,
        onUpdate: ({ value }) => {
          this.handleStateUpdate(value).catch((err) => {
            this.error(`Error updating switch state on ${this.basePath}.state:`, err);
          });
        },
      }),
    );

    if (this.hasCapability('dim')) {
      this.unsubs.push(
        pool.subscribe(this.serverId, {
          subscriberId: subId,
          path: `${this.basePath}.dimmingLevel`,
          tier,
          sourceFilter,
          onUpdate: ({ value }) => {
            this.handleDimmingUpdate(value).catch((err) => {
              this.error(`Error updating dimmer level on ${this.basePath}.dimmingLevel:`, err);
            });
          },
        }),
      );
    }
  }

  private async handleStateUpdate(value: unknown): Promise<void> {
    if (typeof value === 'boolean') {
      await this.setCapabilityValue('onoff', value);
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      await this.setCapabilityValue('onoff', value !== 0);
    }
  }

  private async handleDimmingUpdate(value: unknown): Promise<void> {
    if (typeof value === 'number' && Number.isFinite(value)) {
      const clamped = Math.max(0, Math.min(1, value));
      if (this.hasCapability('dim')) {
        await this.setCapabilityValue('dim', clamped);
      }
      if (this.hasCapability('onoff')) {
        await this.setCapabilityValue('onoff', clamped > 0);
      }
    }
  }

  private registerCapabilityListeners(): void {
    this.registerCapabilityListener('onoff', async (val: boolean) => {
      const nextBool = Boolean(val);
      const prevBool = this.getCapabilityValue('onoff');
      await this.setCapabilityValue('onoff', nextBool);

      try {
        await this.executePut(`${this.basePath}.state`, nextBool);
      } catch (err) {
        await this.setCapabilityValue('onoff', prevBool ?? null).catch(() => {});
        throw err;
      }
    });

    if (this.hasCapability('dim')) {
      this.registerCapabilityListener('dim', async (val: number) => {
        const clamped = Math.max(0, Math.min(1, Number(val)));
        if (!Number.isFinite(clamped)) {
          throw new Error('Dimming level must be a finite number between 0 and 1');
        }

        const prevDim = this.getCapabilityValue('dim');
        const prevOnOff = this.getCapabilityValue('onoff');
        await this.setCapabilityValue('dim', clamped);
        await this.setCapabilityValue('onoff', clamped > 0);

        try {
          await this.executePut(`${this.basePath}.dimmingLevel`, clamped);
        } catch (err) {
          await this.setCapabilityValue('dim', prevDim ?? null).catch(() => {});
          await this.setCapabilityValue('onoff', prevOnOff ?? null).catch(() => {});
          throw err;
        }
      });
    }
  }

  private async executePut(path: string, value: unknown): Promise<void> {
    const pool = resolveConnectionPool(this.homey);
    if (!pool) {
      throw new Error('Signal K connection pool is not initialized');
    }

    const source = this.resolveSourceFilter();
    const timeoutMs = this.resolvePutTimeoutMs();

    const result = await pool.putPath(this.serverId, path, value, {
      source,
      timeoutMs,
    });

    if (result.state === 'FAILED') {
      if (result.statusCode === 401 || result.statusCode === 403) {
        await this.setUnavailable(
          result.message || 'Authentication required — please use Repair Device.',
        ).catch(() => {});
      }

      const statusCode =
        result.statusCode === 408 ? 504 : result.statusCode || 500;
      const err = new Error(
        result.message || `Signal K PUT failed (${statusCode})`,
      ) as Error & { statusCode?: number; state?: string };
      err.statusCode = statusCode;
      err.state = 'FAILED';
      throw err;
    }
  }

  public override async onSettings({
    changedKeys,
  }: {
    oldSettings: { [key: string]: boolean | string | number | undefined | null };
    newSettings: { [key: string]: boolean | string | number | undefined | null };
    changedKeys: string[];
  }): Promise<string | void> {
    if (changedKeys.includes('throttleTier') || changedKeys.includes('sourceFilter')) {
      this.bindSubscriptions();
    }
  }

  public override onDiscoveryResult(discoveryResult: any): boolean {
    const dataId = this.getData()?.id;
    const storeServerId = this.getStoreValue('serverId');
    return (
      discoveryResult?.id === dataId ||
      discoveryResult?.id === storeServerId ||
      discoveryResult?.txt?.self === storeServerId
    );
  }

  public override async onDiscoveryAddressChanged(discoveryResult: any): Promise<void> {
    const nextHost = discoveryResult?.address || discoveryResult?.host;
    const nextPort = Number(discoveryResult?.port) || 3000;
    if (nextHost) {
      await this.setStoreValue('host', nextHost);
    }
    await this.setStoreValue('port', nextPort);
    const pool = resolveConnectionPool(this.homey);
    if (pool && nextHost) {
      await pool.updateServerAddress(this.serverId, nextHost, nextPort);
    }
    await this.setAvailable();
  }

  private clearPathSubscriptions(): void {
    for (const unsub of this.unsubs) {
      try {
        unsub();
      } catch {
        // Ignore teardown errors
      }
    }
    this.unsubs = [];
  }

  private clearSubscriptions(): void {
    this.clearPathSubscriptions();
    if (this.authUnsub) {
      try {
        this.authUnsub();
      } catch {
        // Ignore
      }
      this.authUnsub = null;
    }
  }

  public override async onUninit(): Promise<void> {
    this.clearSubscriptions();
  }
}

export default DigitalSwitchDevice;
module.exports = DigitalSwitchDevice;
module.exports.DigitalSwitchDevice = DigitalSwitchDevice;
