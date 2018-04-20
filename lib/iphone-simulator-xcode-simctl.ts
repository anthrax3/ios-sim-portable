///<reference path="./.d.ts"/>
"use strict";

import childProcess = require("./child-process");
import * as child_process from "child_process";
import errors = require("./errors");

import common = require("./iphone-simulator-common");
import path = require("path");
import { Simctl } from "./simctl";
import util = require("util");
import utils = require("./utils");
import xcode = require("./xcode");
import * as _ from "lodash";

import { IPhoneSimulatorNameGetter } from "./iphone-simulator-name-getter";

const osenv = require("osenv");

export class XCodeSimctlSimulator extends IPhoneSimulatorNameGetter implements ISimulator {
	private static DEVICE_IDENTIFIER_PREFIX = "com.apple.CoreSimulator.SimDeviceType";
	private deviceLogChildProcess: any = null;
	private isDeviceLogOperationStarted = false;
	public defaultDeviceIdentifier = "iPhone 6";

	private simctl: ISimctl = null;

	constructor() {
		super();
		this.simctl = new Simctl();
	}

	public getDevices(): IDevice[] {
		return this.simctl.getDevices();
	}

	public getSdks(): ISdk[] {
		let devices = this.simctl.getDevices();
		return _.map(devices, device => {
			return {
				displayName: `iOS ${device.runtimeVersion}`,
				version: device.runtimeVersion
			};
		});
	}

	public run(applicationPath: string, applicationIdentifier: string, options: IOptions): string {
		let device = this.getDeviceToRun(options);
		let currentBootedDevice = _.find(this.getDevices(), device => this.isDeviceBooted(device));
		if (currentBootedDevice && (currentBootedDevice.name.toLowerCase() !== device.name.toLowerCase() || currentBootedDevice.runtimeVersion !== device.runtimeVersion)) {
			this.killSimulator();
		}

		this.startSimulator(options, device);
		if (!options.skipInstall) {
			this.simctl.install(device.id, applicationPath);
		}

		return this.simctl.launch(device.id, applicationIdentifier, options);
	}

	public sendNotification(notification: string, deviceId: string): void {
		let device = this.getDeviceFromIdentifier(deviceId);
		if (!device) {
			errors.fail("Could not find device.");
		}

		this.simctl.notifyPost(deviceId, notification);
	}

	public getApplicationPath(deviceId: string, applicationIdentifier: string): string {
		return this.simctl.getAppContainer(deviceId, applicationIdentifier);
	}

	public getInstalledApplications(deviceId: string): IApplication[] {
		return common.getInstalledApplications(deviceId);
	}

	public installApplication(deviceId: string, applicationPath: string): void {
		return this.simctl.install(deviceId, applicationPath);
	}

	public uninstallApplication(deviceId: string, appIdentifier: string): void {
		return this.simctl.uninstall(deviceId, appIdentifier, { skipError: true });
	}

	public startApplication(deviceId: string, appIdentifier: string, options: IOptions): string {
		// simctl launch command does not launch the process immediately and we have to wait a little bit,
		// just to ensure all related processes and services are alive.
		const launchResult = this.simctl.launch(deviceId, appIdentifier, options);
		utils.sleep(0.5);
		return launchResult;
	}

	public stopApplication(deviceId: string, appIdentifier: string, bundleExecutable: string): string {
		try {
			let xcodeMajorVersion: number = null;
			try {
				const xcodeVersion = xcode.getXcodeVersionData();
				xcodeMajorVersion = +xcodeVersion.major;
			} catch (err) {
				// Ignore the error.
			}

			let resultOfTermination: string;
			if (xcodeMajorVersion && xcodeMajorVersion < 8) {
				// Xcode 7.x does not have support for `xcrun simctl terminate` command
				resultOfTermination = childProcess.execSync(`killall ${bundleExecutable}`, { skipError: true });
			} else {
				resultOfTermination = this.simctl.terminate(deviceId, appIdentifier);
			}

			// killall command does not terminate the processes immediately and we have to wait a little bit,
			// just to ensure all related processes and services are dead.
			// Same is valid for simctl terminate when Simulator's OS version is below 10.
			utils.sleep(0.5);

			return resultOfTermination;
		} catch (e) {
		}
	}

	public getDeviceLogProcess(deviceId: string, predicate?: string): child_process.ChildProcess {
		if (!this.isDeviceLogOperationStarted) {
			const device = this.getDeviceFromIdentifier(deviceId);
			const deviceVersion = device ? device.runtimeVersion : "";
			const majorVersion = deviceVersion.split(".")[0];

			if (majorVersion && parseInt(majorVersion) >= 11) {
				this.deviceLogChildProcess = this.simctl.getLog(deviceId, predicate);
			} else {
				const logFilePath = path.join(osenv.home(), "Library", "Logs", "CoreSimulator", deviceId, "system.log");
				this.deviceLogChildProcess = require("child_process").spawn("tail", ['-f', '-n', '1', logFilePath]);
			}

			this.isDeviceLogOperationStarted = true;
		}

		return this.deviceLogChildProcess;
	}

	private getDeviceToRun(options: IOptions): IDevice {
		let devices = this.simctl.getDevices(),
			sdkVersion = options.sdkVersion || options.sdk;

		let result = _.find(devices, (device: IDevice) => {
			if (sdkVersion && !options.device) {
				return device.runtimeVersion === sdkVersion;
			}

			if (options.device && !sdkVersion) {
				return device.name === options.device || device.id === options.device;
			}

			if (options.device && sdkVersion) {
				return device.runtimeVersion === sdkVersion && (device.name === options.device || device.id === options.device);
			}

			if (!sdkVersion && !options.device) {
				return this.isDeviceBooted(device);
			}
		});

		if (!result) {
			result = _.find(devices, (device: IDevice) => device.name === this.defaultDeviceIdentifier);
		}

		if (!result) {
			let sortedDevices = _.sortBy(devices, (device) => device.runtimeVersion);
			result = _.last(sortedDevices);
		}

		return result;
	}

	private isDeviceBooted(device: IDevice): boolean {
		return device.state === 'Booted';
	}

	private getBootedDevice(): IDevice {
		let devices = this.simctl.getDevices();
		return _.find(devices, device => this.isDeviceBooted(device));
	}

	private getBootedDevices(): IDevice[] {
		const devices = this.simctl.getDevices();
		return _.filter(devices, device => this.isDeviceBooted(device));
	}

	public startSimulator(options: IOptions, device?: IDevice): void {
		device = device || this.getDeviceToRun(options);

		// In case the id is undefined, skip verification - we'll start default simulator.
		if (device.id) {
			this.verifyDevice(device);
		}

		if (!this.isDeviceBooted(device)) {
			const isSimulatorAppRunning = this.isSimulatorAppRunning();
			const haveBootedDevices = this.haveBootedDevices();
				
			if (isSimulatorAppRunning) {
				// In case user closes simulator window but simulator app is still alive
				if (!haveBootedDevices) {
					device = this.getDeviceToRun(options);
				}
				this.simctl.boot(device.id);
			} else {
				common.startSimulator(device.id);
			}

			common.startSimulator(device.id);
			// startSimulaltor doesn't always finish immediately, and the subsequent
			// install fails since the simulator is not running.
			// Give it some time to start before we attempt installing.
			utils.sleep(1);
		}
	}

	private haveBootedDevices(): boolean {
		const bootedDevices = this.getBootedDevices();
		return bootedDevices && bootedDevices.length > 0;
	}

	private isSimulatorAppRunning(): boolean {
		const simulatorAppName = "Simulator";

		try {
			const output = childProcess.execSync(`ps cax | grep -w ${simulatorAppName}`);
			return output.indexOf(simulatorAppName) !== -1;
		} catch (e) {
			return false;
		}
	}

	private verifyDevice(device: IDevice): void {
		const availableDevices = this.getDevices();
		if (!_.find(availableDevices, { id: device.id })) {
			errors.fail(`No simulator image available for device identifier '${device.id}'.`);
		}
	}

	private getDeviceFromIdentifier(deviceId: string) {
		const availableDevices = this.getDevices();

		return _.find(availableDevices, { id: deviceId });
	}

	private killSimulator(): void {
		childProcess.execSync("pkill -9 -f Simulator");
	}
}
