import { isNil, omitBy } from 'lodash';

import { ExpoConfig } from '../Config.types';
import { ExpoPlist } from './IosConfig.types';

export enum Config {
  ENABLED = 'EXUpdatesEnabled',
  CHECK_ON_LAUNCH = 'EXUpdatesCheckOnLaunch',
  LAUNCH_WAIT_MS = 'EXUpdatesLaunchWaitMs',
  RUNTIME_VERSION = 'EXUpdatesRuntimeVersion',
  SDK_VERSION = 'EXUpdatesSDKVersion',
  UPDATE_URL = 'EXUpdatesURL',
}

export function getUpdateUrl(config: ExpoConfig, username: string | null) {
  const user = typeof config.owner === 'string' ? config.owner : username;
  if (!user) {
    return null;
  }
  return `https://exp.host/@${user}/${config.slug}`;
}

export function getRuntimeVersion(config: ExpoConfig) {
  return typeof config.runtimeVersion === 'string' ? config.runtimeVersion : null;
}

export function getSDKVersion(config: ExpoConfig) {
  return typeof config.sdkVersion === 'string' ? config.sdkVersion : null;
}

export function getUpdatesEnabled(config: ExpoConfig) {
  return config.updates?.enabled !== false;
}

export function getUpdatesTimeout(config: ExpoConfig) {
  return config.updates?.fallbackToCacheTimeout ?? 0;
}

export function getUpdatesCheckOnLaunch(config: ExpoConfig) {
  if (config.updates?.checkAutomatically === 'ON_ERROR_RECOVERY') {
    return 'NEVER';
  } else if (config.updates?.checkAutomatically === 'ON_LOAD') {
    return 'ALWAYS';
  }
  return 'ALWAYS';
}

export function setUpdatesConfig(
  config: ExpoConfig,
  expoPlist: ExpoPlist,
  username: string | null
) {
  let newExpoPlist = {
    ...expoPlist,
    [Config.ENABLED]: getUpdatesEnabled(config),
    [Config.UPDATE_URL]: getUpdateUrl(config, username),
    [Config.CHECK_ON_LAUNCH]: getUpdatesCheckOnLaunch(config),
    [Config.LAUNCH_WAIT_MS]: getUpdatesTimeout(config),
  };

  const runtimeVersion = getRuntimeVersion(config);
  if (runtimeVersion) {
    newExpoPlist = {
      ...newExpoPlist,
      [Config.RUNTIME_VERSION]: runtimeVersion,
      [Config.SDK_VERSION]: undefined,
    };
  } else {
    const sdkVersion = getSDKVersion(config);
    if (sdkVersion) {
      newExpoPlist = {
        ...newExpoPlist,
        [Config.SDK_VERSION]: sdkVersion,
        [Config.RUNTIME_VERSION]: undefined,
      };
    }
  }

  return omitBy(newExpoPlist, isNil);
}
