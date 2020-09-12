import {
  AndroidConfig,
  ExpoConfig,
  IOSConfig,
  getConfig,
  getExpoSDKVersion,
  getPackageJson,
} from '@expo/config';
import plist from '@expo/plist';
import { UserManager } from '@expo/xdl';
import chalk from 'chalk';
import figures from 'figures';
import * as fs from 'fs-extra';
import glob from 'glob';
import ora from 'ora';
import path from 'path';
import xcode from 'xcode';

import { gitAddAsync } from '../../../git';
import log from '../../../log';
import * as gitUtils from './git';

const iOSBuildScript = '../node_modules/expo-updates/scripts/create-manifest-ios.sh';
const androidBuildScript =
  'apply from: "../../node_modules/expo-updates/scripts/create-manifest-android.gradle"';

export async function isUpdatesConfigured(projectDir: string): Promise<boolean> {
  if (!isExpoUpdatesInstalled(projectDir)) {
    return true;
  }

  const { exp, username } = await getConfigurationOptions(projectDir);

  return (
    (await isUpdatesConfiguredAndroid(projectDir, exp, username)) &&
    (await isUpdatesConfiguredIOS(projectDir, exp, username))
  );
}

export async function configureUpdatesAsync({
  projectDir,
  nonInteractive,
}: {
  projectDir: string;
  nonInteractive: boolean;
}) {
  if (!isExpoUpdatesInstalled(projectDir)) {
    return;
  }

  const spinner = ora('Configuring expo-updates');

  try {
    const { exp, username } = await getConfigurationOptions(projectDir);

    await configureUpdatesAndroid(projectDir, exp, username);
    await configureUpdatesIOS(projectDir, exp, username);

    await gitUtils.ensureGitStatusIsCleanAsync();

    spinner.succeed();
  } catch (err) {
    if (err instanceof gitUtils.DirtyGitTreeError) {
      spinner.succeed(`We configured expo-updates in your project `);
      log.newLine();

      try {
        await gitUtils.reviewAndCommitChangesAsync(`Configure expo-updates`, { nonInteractive });

        log(`${chalk.green(figures.tick)} Successfully committed the configuration changes.`);
      } catch (e) {
        throw new Error(
          "Aborting, run the command again once you're ready. Make sure to commit any changes you've made."
        );
      }
    } else {
      spinner.fail();
      throw err;
    }
  }
}

async function getConfigurationOptions(
  projectDir: string
): Promise<{ exp: ExpoConfig; username: string | null }> {
  const user = await UserManager.ensureLoggedInAsync();

  const { exp } = getConfig(projectDir);

  if (!exp.runtimeVersion && !exp.sdkVersion) {
    throw new Error(
      "Couldn't find either 'runtimeVersion' or 'sdkVersion' to configure 'expo-updates'. Please specify at least one of these properties under the 'expo' key in 'app.json'"
    );
  }

  return { exp, username: user.username };
}

function isExpoUpdatesInstalled(projectDir: string) {
  const packageJson = getPackageJson(projectDir);

  return packageJson.dependencies && 'expo-updates' in packageJson.dependencies;
}

async function configureUpdatesIOS(projectDir: string, exp: ExpoConfig, username: string | null) {
  const pbxprojPath = await getPbxprojPath(projectDir);
  const project = await getXcodeProject(pbxprojPath);
  const bundleReactNative = await getBundleReactNativePhase(project);

  if (!bundleReactNative.shellScript.includes(iOSBuildScript)) {
    bundleReactNative.shellScript = `${bundleReactNative.shellScript.replace(
      /"$/,
      ''
    )}${iOSBuildScript}\\n"`;
  }

  await fs.writeFile(pbxprojPath, project.writeSync());

  const expoPlistPath = getExpoPlistPath(projectDir, pbxprojPath);

  let expoPlist = {};

  if (await fs.pathExists(path.dirname(expoPlistPath))) {
    const expoPlistContent = await fs.readFile(expoPlistPath, 'utf8');
    expoPlist = plist.parse(expoPlistContent);
  }

  const expoPlistContent = plist.build(
    IOSConfig.Updates.setUpdatesConfig(exp, expoPlist, username)
  );

  if (!(await fs.pathExists(path.dirname(expoPlistPath)))) {
    await fs.mkdirp(path.dirname(expoPlistPath));
  }

  await fs.writeFile(expoPlistPath, expoPlistContent);
  await gitAddAsync(expoPlistPath, { intentToAdd: true });
}

async function isUpdatesConfiguredIOS(
  projectDir: string,
  exp: ExpoConfig,
  username: string | null
) {
  const pbxprojPath = await getPbxprojPath(projectDir);
  const project = await getXcodeProject(pbxprojPath);
  const bundleReactNative = await getBundleReactNativePhase(project);

  if (!bundleReactNative.shellScript.includes(iOSBuildScript)) {
    return false;
  }

  const expoPlistPath = getExpoPlistPath(projectDir, pbxprojPath);

  if (!(await fs.pathExists(expoPlistPath))) {
    return false;
  }

  const expoPlist = await fs.readFile(expoPlistPath, 'utf8');
  const expoPlistData = plist.parse(expoPlist);

  const currentSdkVersion = IOSConfig.Updates.getSDKVersion(exp);
  const currentRuntimeVersion = IOSConfig.Updates.getRuntimeVersion(exp);
  const currentUpdateUrl = IOSConfig.Updates.getUpdateUrl(exp, username);

  if (
    (currentRuntimeVersion
      ? expoPlistData[IOSConfig.Updates.Config.RUNTIME_VERSION] === currentRuntimeVersion
      : expoPlistData[IOSConfig.Updates.Config.SDK_VERSION] === currentSdkVersion) &&
    expoPlistData[IOSConfig.Updates.Config.UPDATE_URL] === currentUpdateUrl
  ) {
    return true;
  }

  return false;
}

async function getPbxprojPath(projectDir: string) {
  const pbxprojPaths = await new Promise<string[]>((resolve, reject) =>
    glob('ios/*/project.pbxproj', { absolute: true, cwd: projectDir }, (err, res) => {
      if (err) {
        reject(err);
      } else {
        resolve(res);
      }
    })
  );

  const pbxprojPath = pbxprojPaths.length > 0 ? pbxprojPaths[0] : undefined;

  if (!pbxprojPath) {
    throw new Error("Couldn't find Xcode project");
  }

  return pbxprojPath;
}

async function getXcodeProject(pbxprojPath: string) {
  const project = xcode.project(pbxprojPath);

  await new Promise((resolve, reject) =>
    project.parse(err => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    })
  );

  return project;
}

function getExpoPlistPath(projectDir: string, pbxprojPath: string) {
  const xcodeprojPath = path.resolve(pbxprojPath, '..');
  const expoPlistPath = path.resolve(
    projectDir,
    'ios',
    path.basename(xcodeprojPath).replace(/\.xcodeproj$/, ''),
    'Supporting',
    'Expo.plist'
  );

  return expoPlistPath;
}

async function getBundleReactNativePhase(project: xcode.XcodeProject) {
  const scriptBuildPhase = project.hash.project.objects.PBXShellScriptBuildPhase;
  const bundleReactNative = Object.values(scriptBuildPhase).find(
    buildPhase => buildPhase.name === '"Bundle React Native code and images"'
  );

  if (!bundleReactNative) {
    throw new Error(`Couldn't find a build phase script for "Bundle React Native code and images"`);
  }

  return bundleReactNative;
}

async function configureUpdatesAndroid(
  projectDir: string,
  exp: ExpoConfig,
  username: string | null
) {
  const buildGradlePath = getAndroidBuildGradlePath(projectDir);
  const buildGradleContent = await getAndroidBuildGradleContent(buildGradlePath);

  if (!hasBuildScriptApply(buildGradleContent)) {
    await fs.writeFile(
      buildGradlePath,
      `${buildGradleContent}\n// Integration with Expo updates\n${androidBuildScript}\n`
    );
  }

  const androidManifestPath = getAndroidManifestPath(projectDir);
  const androidManifestJSON = await AndroidConfig.Manifest.readAndroidManifestAsync(
    androidManifestPath
  );

  if (!isAndroidMetadataSet(androidManifestJSON, exp, username)) {
    const result = await AndroidConfig.Updates.setUpdatesConfig(exp, androidManifestJSON, username);

    await AndroidConfig.Manifest.writeAndroidManifestAsync(androidManifestPath, result);
  }
}

async function isUpdatesConfiguredAndroid(
  projectDir: string,
  exp: ExpoConfig,
  username: string | null
) {
  const buildGradlePath = getAndroidBuildGradlePath(projectDir);
  const buildGradleContent = await getAndroidBuildGradleContent(buildGradlePath);

  if (!hasBuildScriptApply(buildGradleContent)) {
    return false;
  }

  const androidManifestPath = getAndroidManifestPath(projectDir);
  const androidManifestJSON = await AndroidConfig.Manifest.readAndroidManifestAsync(
    androidManifestPath
  );

  if (!isAndroidMetadataSet(androidManifestJSON, exp, username)) {
    return false;
  }

  return true;
}

function getAndroidBuildGradlePath(projectDir: string) {
  const buildGradlePath = path.join(projectDir, 'android', 'app', 'build.gradle');

  return buildGradlePath;
}

async function getAndroidBuildGradleContent(buildGradlePath: string) {
  if (!(await fs.pathExists(buildGradlePath))) {
    throw new Error(`Couldn't find gradle build script at ${buildGradlePath}`);
  }

  const buildGradleContent = await fs.readFile(buildGradlePath, 'utf-8');

  return buildGradleContent;
}

function hasBuildScriptApply(buildGradleContent: string): boolean {
  return (
    buildGradleContent
      .split('\n')
      // Check for both single and double quotes
      .some(line => line === androidBuildScript || line === androidBuildScript.replace(/"/g, "'"))
  );
}

function getAndroidManifestPath(projectDir: string) {
  const manifestPath = path.join(
    projectDir,
    'android',
    'app',
    'src',
    'main',
    'AndroidManifest.xml'
  );

  return manifestPath;
}

function isAndroidMetadataSet(
  androidManifestJSON: AndroidConfig.Manifest.Document,
  exp: ExpoConfig,
  username: string | null
): boolean {
  const currentSdkVersion = AndroidConfig.Updates.getSDKVersion(exp);
  const currentRuntimeVersion = AndroidConfig.Updates.getRuntimeVersion(exp);
  const currentUpdateUrl = AndroidConfig.Updates.getUpdateUrl(exp, username);

  const setRuntimeVersion = getAndroidMetadataValue(
    androidManifestJSON,
    AndroidConfig.Updates.Config.RUNTIME_VERSION
  );

  const setSdkVersion = getAndroidMetadataValue(
    androidManifestJSON,
    AndroidConfig.Updates.Config.SDK_VERSION
  );

  const setUpdateUrl = getAndroidMetadataValue(
    androidManifestJSON,
    AndroidConfig.Updates.Config.UPDATE_URL
  );

  return Boolean(
    (currentRuntimeVersion
      ? setRuntimeVersion === currentRuntimeVersion
      : setSdkVersion === currentSdkVersion) && setUpdateUrl === currentUpdateUrl
  );
}

function getAndroidMetadataValue(
  androidManifestJSON: AndroidConfig.Manifest.Document,
  name: string
): string | undefined {
  if (androidManifestJSON.hasOwnProperty('meta-data')) {
    return androidManifestJSON['meta-data'].find((e: any) => e['$']['android:name'] === name);
  }
  return undefined;
}
