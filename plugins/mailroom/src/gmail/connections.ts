import { AsyncLocalStorage } from 'node:async_hooks';
import type { AccountConfig } from '../types.js';
import type { GmailGateway } from './gateway.js';

export interface ConnectedGateway {
  account: AccountConfig;
  gateway: GmailGateway;
}

export type GatewayProvider = (alias: string) => Promise<ConnectedGateway>;

/**
 * Reuses Config, Keychain, OAuth, and Gmail client setup only while one
 * top-level operation is running. Nothing survives into the next tool call.
 */
export class OperationConnections {
  private readonly active = new AsyncLocalStorage<Map<string, Promise<ConnectedGateway>>>();

  public constructor(private readonly provide: GatewayProvider) {}

  public async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active.getStore()) return await work();
    return await this.active.run(new Map(), work);
  }

  public async get(alias: string): Promise<ConnectedGateway> {
    const connections = this.active.getStore();
    if (!connections) return await this.provide(alias);
    const existing = connections.get(alias);
    if (existing) return await existing;
    const pending = this.provide(alias);
    connections.set(alias, pending);
    try {
      return await pending;
    } catch (error) {
      connections.delete(alias);
      throw error;
    }
  }
}
