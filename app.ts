import Homey from 'homey';
import {
  SignalKConnectionPool,
  ServerConnectionConfig,
} from './lib/SignalKConnectionPool';
import { SignalKAuthManager } from './lib/SignalKAuthManager';
import { SignalKPutController } from './lib/SignalKPutController';
import { PathDiscoveryService } from './lib/PathDiscoveryService';
import { UnitConverter } from './lib/UnitConverter';
import { AnchorWatchCalculator } from './lib/AnchorWatchCalculator';
import { SafetyBoundary } from './lib/SafetyBoundary';
import { FlowCardManager } from './lib/FlowCardManager';

export const SETTINGS_KEYS = {
  CLIENT_ID: 'signalk_client_id',
  DEFAULT_SERVER_ID: 'signalk_default_server_id',
  SERVERS: 'signalk_servers',
} as const;

export interface StoredServerEntry extends ServerConnectionConfig {
  name?: string;
}

export class SignalKMarineApp extends Homey.App {
  public safetyBoundary!: SafetyBoundary;
  public unitConverter!: UnitConverter;
  public anchorCalculator!: AnchorWatchCalculator;
  public authManager!: SignalKAuthManager;
  public putController!: SignalKPutController;
  public connectionPool!: SignalKConnectionPool;
  public discoveryService!: PathDiscoveryService;
  public flowCardManager!: FlowCardManager;

  private defaultServerId: string = 'default';
  private serverConfigs = new Map<string, ServerConnectionConfig>();
  private initialized = false;

  /**
   * Initializes core Signal K services, restores saved server connections,
   * and registers all Homey Flow Trigger, Condition, and Action cards.
   */
  public async onInit(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.safetyBoundary = new SafetyBoundary();
    this.unitConverter = new UnitConverter();
    this.anchorCalculator = new AnchorWatchCalculator();
    this.authManager = new SignalKAuthManager();
    this.putController = new SignalKPutController(this.safetyBoundary);
    this.connectionPool = new SignalKConnectionPool({
      authManager: this.authManager,
      putController: this.putController,
      safetyBoundary: this.safetyBoundary,
    });
    this.discoveryService = new PathDiscoveryService(this.safetyBoundary);
    this.flowCardManager = new FlowCardManager(this.homey, this);

    this.ensureClientId();
    this.restoreServerRegistryFromSettings();

    // Register all Flow cards and listeners
    this.flowCardManager.registerAll();

    // Attach flow subscriptions for any known servers and reconnect saved servers
    for (const serverId of this.serverConfigs.keys()) {
      this.flowCardManager.attachServerSubscriptions(serverId);
    }

    // Listen for pool auth errors so devices/app can log clearly
    this.connectionPool.on('authError', ({ serverId, statusCode }) => {
      this.error(
        `Signal K authentication error on server "${serverId}" (HTTP ${statusCode})`,
      );
    });

    this.initialized = true;
    this.log('Signal K Marine App initialized');
  }

  /**
   * Cleanly shuts down Flow subscriptions and closes all managed WebSocket
   * connections and reconnect timers.
   */
  public async onUninit(): Promise<void> {
    this.initialized = false;

    if (this.flowCardManager) {
      try {
        this.flowCardManager.destroy();
      } catch (err) {
        this.error('Error destroying FlowCardManager:', err);
      }
    }

    if (this.connectionPool) {
      try {
        await this.connectionPool.closeAll();
      } catch (err) {
        this.error('Error closing SignalKConnectionPool:', err);
      }
    }

    this.log('Signal K Marine App uninitialized');
  }

  // ---------------------------------------------------------------------------
  // Service Registry Accessors (used by Drivers via this.homey.app)
  // ---------------------------------------------------------------------------

  public getConnectionPool(): SignalKConnectionPool {
    return this.connectionPool;
  }

  public getAuthManager(): SignalKAuthManager {
    return this.authManager;
  }

  public getPutController(): SignalKPutController {
    return this.putController;
  }

  public getDiscoveryService(): PathDiscoveryService {
    return this.discoveryService;
  }

  public getUnitConverter(): UnitConverter {
    return this.unitConverter;
  }

  public getAnchorCalculator(): AnchorWatchCalculator {
    return this.anchorCalculator;
  }

  public getSafetyBoundary(): SafetyBoundary {
    return this.safetyBoundary;
  }

  public getFlowCardManager(): FlowCardManager {
    return this.flowCardManager;
  }

  // ---------------------------------------------------------------------------
  // Client ID & Server Connection Registry Helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns a persistent RFC 4122 UUIDv4 `clientId` stored in Homey app settings.
   */
  public ensureClientId(): string {
    const existing = this.homey?.settings?.get?.(SETTINGS_KEYS.CLIENT_ID);
    if (typeof existing === 'string' && this.authManager.isValidUuidV4(existing)) {
      return existing;
    }
    const generated = this.authManager.generateClientId();
    this.homey?.settings?.set?.(SETTINGS_KEYS.CLIENT_ID, generated);
    return generated;
  }

  /**
   * Returns the active default server ID, falling back to the first registered
   * server or `'default'`.
   */
  public getDefaultServerId(): string {
    const storedDefault = this.homey?.settings?.get?.(SETTINGS_KEYS.DEFAULT_SERVER_ID);
    if (typeof storedDefault === 'string' && storedDefault.trim().length > 0) {
      return storedDefault.trim();
    }
    if (this.defaultServerId && this.serverConfigs.has(this.defaultServerId)) {
      return this.defaultServerId;
    }
    const firstKey = this.serverConfigs.keys().next().value;
    return firstKey || this.defaultServerId || 'default';
  }

  /**
   * Sets the default server ID and persists it to Homey app settings.
   */
  public setDefaultServerId(serverId: string): void {
    const cleanId = typeof serverId === 'string' ? serverId.trim() : '';
    if (!cleanId) {
      return;
    }
    this.defaultServerId = cleanId;
    this.homey?.settings?.set?.(SETTINGS_KEYS.DEFAULT_SERVER_ID, cleanId);
  }

  /**
   * Registers or updates a Signal K server configuration, persists it, ensures
   * a shared WebSocket connection, and attaches Flow subscriptions.
   */
  public async connectServer(config: ServerConnectionConfig): Promise<void> {
    const serverId = config.serverId?.trim() || `${config.host}:${config.port}`;
    const normalizedConfig: ServerConnectionConfig = {
      ...config,
      serverId,
      clientId: config.clientId || this.ensureClientId(),
    };

    this.serverConfigs.set(serverId, normalizedConfig);
    if (this.serverConfigs.size === 1 || this.defaultServerId === 'default') {
      this.setDefaultServerId(serverId);
    }
    this.persistServerRegistryToSettings();

    await this.connectionPool.acquireConnection(normalizedConfig);
    this.flowCardManager.attachServerSubscriptions(serverId);
  }

  /**
   * Returns a stored server configuration if present.
   */
  public getServerConfig(serverId?: string): ServerConnectionConfig | undefined {
    const id = serverId || this.getDefaultServerId();
    return this.serverConfigs.get(id);
  }

  /**
   * Lists all registered server IDs.
   */
  public getRegisteredServerIds(): string[] {
    return Array.from(this.serverConfigs.keys());
  }

  /**
   * Updates the host/port of a registered server (e.g., on mDNS address change)
   * and persists the updated configuration.
   */
  public async updateServerAddress(
    serverId: string,
    host: string,
    port: number,
  ): Promise<void> {
    const existing = this.serverConfigs.get(serverId);
    if (existing) {
      existing.host = host;
      existing.port = port;
      this.persistServerRegistryToSettings();
    }
    await this.connectionPool.updateServerAddress(serverId, host, port);
  }

  private restoreServerRegistryFromSettings(): void {
    const savedDefault = this.homey?.settings?.get?.(SETTINGS_KEYS.DEFAULT_SERVER_ID);
    if (typeof savedDefault === 'string' && savedDefault.trim().length > 0) {
      this.defaultServerId = savedDefault.trim();
    }

    const rawServers = this.homey?.settings?.get?.(SETTINGS_KEYS.SERVERS);
    if (rawServers && typeof rawServers === 'object' && !Array.isArray(rawServers)) {
      for (const [id, cfg] of Object.entries(rawServers as Record<string, any>)) {
        if (cfg && typeof cfg === 'object' && typeof cfg.host === 'string' && typeof cfg.port === 'number') {
          this.serverConfigs.set(id, {
            serverId: id,
            host: cfg.host,
            port: cfg.port,
            useTls: Boolean(cfg.useTls),
            allowSelfSigned: cfg.allowSelfSigned !== undefined ? Boolean(cfg.allowSelfSigned) : true,
            token: typeof cfg.token === 'string' ? cfg.token : undefined,
            clientId: typeof cfg.clientId === 'string' ? cfg.clientId : this.ensureClientId(),
          });
        }
      }
    }
  }

  private persistServerRegistryToSettings(): void {
    const serialized: Record<string, ServerConnectionConfig> = {};
    for (const [id, cfg] of this.serverConfigs.entries()) {
      serialized[id] = { ...cfg };
    }
    this.homey?.settings?.set?.(SETTINGS_KEYS.SERVERS, serialized);
  }
}

export default SignalKMarineApp;
module.exports = SignalKMarineApp;
module.exports.SignalKMarineApp = SignalKMarineApp;
module.exports.SETTINGS_KEYS = SETTINGS_KEYS;
