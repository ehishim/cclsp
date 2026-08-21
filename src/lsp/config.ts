import { existsSync, readFileSync } from 'node:fs';
import { logger } from '../logger.js';
import type { Config } from './types.js';

function validateConfig(config: Config): Config {
  if (!config || !Array.isArray(config.servers)) {
    throw new Error('Configuration must contain a servers array');
  }
  for (const [index, server] of config.servers.entries()) {
    if (
      server.maxOpenDocuments !== undefined &&
      (!Number.isInteger(server.maxOpenDocuments) || server.maxOpenDocuments < 1)
    ) {
      throw new Error(`servers[${index}].maxOpenDocuments must be an integer >= 1`);
    }
  }
  return config;
}

/**
 * Load configuration from CCLSP_CONFIG_PATH env var or the given configPath.
 * Throws on all error conditions instead of calling process.exit.
 */
export function loadConfig(configPath?: string): Config {
  // First try to load from environment variable (MCP config)
  if (process.env.CCLSP_CONFIG_PATH) {
    logger.info(`Loading config from CCLSP_CONFIG_PATH: ${process.env.CCLSP_CONFIG_PATH}\n`);

    if (!existsSync(process.env.CCLSP_CONFIG_PATH)) {
      throw new Error(
        `Config file specified in CCLSP_CONFIG_PATH does not exist: ${process.env.CCLSP_CONFIG_PATH}`
      );
    }

    try {
      const configData = readFileSync(process.env.CCLSP_CONFIG_PATH, 'utf-8');
      const config = validateConfig(JSON.parse(configData) as Config);
      logger.info(`Loaded ${config.servers.length} server configurations from env\n`);
      return config;
    } catch (error) {
      throw new Error(`Failed to load config from CCLSP_CONFIG_PATH: ${error}`);
    }
  }

  // configPath must be provided if CCLSP_CONFIG_PATH is not set
  if (!configPath) {
    throw new Error(
      'configPath is required when CCLSP_CONFIG_PATH environment variable is not set'
    );
  }

  // Try to load from config file
  try {
    logger.info(`Loading config from file: ${configPath}\n`);
    const configData = readFileSync(configPath, 'utf-8');
    const config = validateConfig(JSON.parse(configData) as Config);
    logger.info(`Loaded ${config.servers.length} server configurations\n`);
    return config;
  } catch (error) {
    throw new Error(`Failed to load config from ${configPath}: ${error}`);
  }
}
