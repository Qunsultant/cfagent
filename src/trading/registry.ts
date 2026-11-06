/**
 * Trading Platform Registry & Abstract Factory
 *
 * Implements:
 * - Strategy Pattern (GoF): Pluggable broker implementations.
 * - Factory Pattern (GoF): Dynamic resolution based on configuration and user preference.
 * - Open/Closed Principle (OCP): New platforms register via registerPlatform().
 */

import type { Env } from "../types";
import type { DatabaseORM } from "../orm";
import type { ITradingPlatform, TradingPlatformId } from "./interfaces";

export class TradingPlatformRegistry {
  private static platforms = new Map<TradingPlatformId, (env: Env, orm: DatabaseORM | undefined, userLogin: string, overrideEnv?: string, storage?: import("./screenerPipeline").NasdaqUniverseRouteBundleInput["storage"]) => ITradingPlatform>();

  /**
   * Registers a trading platform provider. The factory may accept an
   * overrideEnv (the caller's requested broker environment, e.g.
   * "live"/"sandbox") — factories that do not model environments
   * simply ignore it.
   */
  static register(id: TradingPlatformId, factory: (env: Env, orm: DatabaseORM | undefined, userLogin: string, overrideEnv?: string, storage?: import("./screenerPipeline").NasdaqUniverseRouteBundleInput["storage"]) => ITradingPlatform): void {
    this.platforms.set(id, factory);
  }

  /**
   * Resolves a trading platform by ID
   */
  static getPlatform(id: TradingPlatformId, env: Env, orm: DatabaseORM | undefined, userLogin: string, overrideEnv?: string, storage?: import("./screenerPipeline").NasdaqUniverseRouteBundleInput["storage"]): ITradingPlatform {
    // Issue #1185: platforms are per-user — an explicit login is
    // required; there is no default identity to resolve under.
    if (!userLogin) {
      throw new Error("TradingPlatformRegistry.getPlatform requires an explicit userLogin (issue #1185: no default identity).");
    }
    const factory = this.platforms.get(id);
    if (!factory) {
      // Issue #3460: no fallback to E*TRADE. An unregistered broker id
      // is a named refusal, never a silent E*TRADE resolution — the
      // registry is the only resolution path, so it must fail closed.
      throw new Error(`Trading platform [${id}] is not registered.`);
    }
    return factory(env, orm, userLogin, overrideEnv, storage);
  }

  /**
   * Lists all available trading platforms
   */
  static getRegisteredPlatforms(): TradingPlatformId[] {
    return Array.from(this.platforms.keys());
  }
}
