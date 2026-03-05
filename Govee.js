import udp from "@SignalRGB/udp";
export function Name() { return "Govee"; }
export function Version() { return "1.0.0"; }
export function Type() { return "network"; }
export function Publisher() { return "WhirlwindFX"; }
export function Size() { return [22, 1]; }
export function DefaultPosition() {return [75, 70]; }
export function DefaultScale() {return 8.0;}

/* global
controller:readonly
discovery: readonly
TurnOffOnShutdown:readonly
variableLedCount:readonly
LightingMode:readonly
forcedColor:readonly
*/
export function ControllableParameters() {
	return [
		{"property":"TurnOffOnShutdown", "group":"settings", "label":"Turn off on App Exit", "type":"boolean", "default":"false"},
		{"property":"LightingMode", "group":"lighting", "label":"Lighting Mode", "type":"combobox", "values":["Canvas", "Forced"], "default":"Canvas"},
		{"property":"forcedColor", "group":"lighting", "label":"Forced Color", "min":"0", "max":"360", "type":"color", "default":"#009bde"},
	];
}

export function SubdeviceController() { return false; }

/** @type {GoveeProtocol} */
let govee;
let ledCount = 4;
let ledNames = [];
let ledPositions = [];
let subdevices = [];

export function Initialize(){
	device.addFeature("base64");

	device.setName(controller.sku);
	device.setImageFromUrl(controller.deviceImage);

	if(UDPServer !== undefined) {
		UDPServer.stop();
		UDPServer = undefined;
	}
	//Make sure we don't have a server floating around still.

	UDPServer = new UdpSocketServer({
		ip : controller.ip,
		broadcastPort : 4003,
		listenPort : 4002
	});

	UDPServer.start();
	//Establish a new udp server. This is now required for using udp.send.

	ClearSubdevices();
	fetchDeviceInfoFromTableAndConfigure();

	govee = new GoveeProtocol(controller.ip, controller.supportDreamView, controller.supportRazer);
	// This is what happens in my wireshark
	govee.setDeviceState(true);
	govee.SetRazerMode(true);
	govee.SetRazerMode(true);
	govee.setDeviceState(true);
}

export function Render(){
	const RGBData = subdevices.length > 0 ? GetRGBFromSubdevices() : GetDeviceRGB();

	govee.SendRGB(RGBData);
	device.pause(10);
}

export function Shutdown(suspend){
	govee.SetRazerMode(false);

	if(TurnOffOnShutdown){
		govee.setDeviceState(false);
	}
}

export function onvariableLedCountChanged(){
	SetLedCount(variableLedCount);
}

function GetRGBFromSubdevices(){
	const RGBData = [];

	for(const subdevice of subdevices){
		const ledPositions = subdevice.ledPositions;

		for(let i = 0 ; i < ledPositions.length; i++){
			const ledPosition = ledPositions[i];
			let color;

			if (LightingMode === "Forced") {
				color = hexToRgb(forcedColor);
			} else {
				color = device.subdeviceColor(subdevice.id, ledPosition[0], ledPosition[1]);
			}

			RGBData[i * 3] = color[0];
			RGBData[i * 3 + 1] = color[1];
			RGBData[i * 3 + 2] = color[2];
		}
	}

	return RGBData;
}

function GetDeviceRGB(){
	const RGBData = new Array(ledCount * 3);

	for(let i = 0 ; i < ledPositions.length; i++){
		const ledPosition = ledPositions[i];
		let color;

		if (LightingMode === "Forced") {
			color = hexToRgb(forcedColor);
		} else {
			color = device.color(ledPosition[0], ledPosition[1]);
		}

		RGBData[i * 3] = color[0];
		RGBData[i * 3 + 1] = color[1];
		RGBData[i * 3 + 2] = color[2];
	}

	return RGBData;
}

function fetchDeviceInfoFromTableAndConfigure() {
	if(GoveeDeviceLibrary.hasOwnProperty(controller.sku)){
		const GoveeDeviceInfo = GoveeDeviceLibrary[controller.sku];
		device.setName(`Govee ${GoveeDeviceInfo.name}`);

		if(GoveeDeviceInfo.hasVariableLedCount){
			device.addProperty({"property": "variableLedCount", label: "Segment Count", "type": "number", "min": 1, "max": 60, default: GoveeDeviceInfo.ledCount, step: 1});
			SetLedCount(variableLedCount);
		}else{
			SetLedCount(GoveeDeviceInfo.ledCount);
			device.removeProperty("variableLedCount");
		}

		if(GoveeDeviceInfo.usesSubDevices){
			device.SetIsSubdeviceController(true);

			for(const subdevice of GoveeDeviceInfo.subdevices){
				CreateSubDevice(subdevice);
			}
		}else{
			device.SetIsSubdeviceController(false);
		}

	}else{
		device.log("Using Default Layout...");
		device.setName(`Govee: ${controller.sku}`);
		SetLedCount(20);
	}
}

function SetLedCount(count){
	ledCount = count;

	CreateLedMap();
	device.setSize([36, 18]);
	device.setControllableLeds(ledNames, ledPositions);
}

function CreateLedMap(){

	ledNames = [];
	ledPositions = [];

	const width = 36;
	const height = 18;

	let index = 1;

	for(let y = 0; y < height; y++){
		for(let x = 0; x < width; x++){

			ledNames.push(`Led ${index}`);
			ledPositions.push([x, y]);

			index++;
		}
	}

	ledCount = width * height;
}

function ClearSubdevices(){
	for(const subdevice of device.getCurrentSubdevices()){
		device.removeSubdevice(subdevice);
	}

	subdevices = [];
}

function CreateSubDevice(subdevice){
	const count = device.getCurrentSubdevices().length;
	device.log(subdevice);
	subdevice.id = `${subdevice.name} ${count + 1}`;
	device.createSubdevice(subdevice.id);

	device.setSubdeviceName(subdevice.id, subdevice.name);
	device.setSubdeviceImage(subdevice.id, "");
	device.setSubdeviceSize(subdevice.id, subdevice.size[0], subdevice.size[1]);
	device.setSubdeviceLeds(subdevice.id, subdevice.ledNames, subdevice.ledPositions);

	subdevices.push(subdevice);
}

function hexToRgb(hex) {
	const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
	const colors = [];
	colors[0] = parseInt(result[1], 16);
	colors[1] = parseInt(result[2], 16);
	colors[2] = parseInt(result[3], 16);

	return colors;
}

let UDPServer;

export function DiscoveryService() {
	this.IconUrl = "https://assets.signalrgb.com/brands/products/govee_ble/icon@2x.png";
	this.firstRun = true;

	this.Initialize = function(){
		service.log("Searching for Govee network devices...");
		this.LoadCachedDevices();
	};

	this.UdpBroadcastPort = 4001;
	this.UdpListenPort = 4002;
	this.UdpBroadcastAddress = "239.255.255.250";

	this.lastPollTime = 0;
	this.PollInterval = 60000;

	this.cache = new IPCache();
	this.activeSockets = new Map();
	this.activeSocketTimer = Date.now();

	this.LoadCachedDevices = function(){
		service.log("Loading Cached Devices...");

		for(const [key, value] of this.cache.Entries()){
			service.log(`Found Cached Device: [${key}: ${JSON.stringify(value)}]`);
			this.checkCachedDevice(value.ip);
		}
	};

	this.checkCachedDevice = function(ipAddress) {
		service.log(`Checking IP: ${ipAddress}`);

		if(UDPServer !== undefined) {
			UDPServer.stop();
			UDPServer = undefined;
		}

		const socketServer = new UdpSocketServer({
			ip : ipAddress,
			isDiscoveryServer : true
		});

		this.activeSockets.set(ipAddress, socketServer);
		this.activeSocketTimer = Date.now();
		socketServer.start();
	};

	this.clearSockets = function() {
		if(Date.now() - this.activeSocketTimer > 10000 && this.activeSockets.size > 0) {
			service.log("Nuking Active Cache Sockets.");

			for(const [key, value] of this.activeSockets.entries()){
				service.log(`Nuking Socket for IP: [${key}]`);
				value.stop();
				this.activeSockets.delete(key);
				//Clear would be more efficient here, however it doesn't kill the socket instantly.
				//We instead would be at the mercy of the GC.
			}
		}
	};

	this.forceDiscovery = function(value) {
		const packetType = JSON.parse(value.response).msg.cmd;
		service.log(`Type: ${packetType}`);

		if(packetType === "scan"){
			service.log(`New host discovered!`);
			service.log(value);
			this.CreateControllerDevice(value);
		}
	};

	this.purgeIPCache = function() {
		this.cache.PurgeCache();
	};

	this.CheckForDevices = function(){
		if(Date.now() - discovery.lastPollTime < discovery.PollInterval){
			return;
		}

		discovery.lastPollTime = Date.now();
		service.log("Broadcasting device scan...");
		service.broadcast(JSON.stringify({
			msg: {
				cmd: "scan",
				data: {
					account_topic: "reserve",
				},
			}
		}));
	};

	this.Update = function(){
		for(const cont of service.controllers){
			cont.obj.update();
		}

		this.clearSockets();
		this.CheckForDevices();
	};

	this.Shutdown = function(){

	};

	this.Discovered = function(value) {

		const packetType = JSON.parse(value.response).msg.cmd;
		service.log(`Type: ${packetType}`);

		if(packetType === "scan"){
			service.log(`New host discovered!`);
			service.log(value);
			this.CreateControllerDevice(value);
		}
	};

	this.Removal = function(value){

	};

	this.CreateControllerDevice = function(value){
		const controller = service.getController(value.id);

		if (controller === undefined) {
			service.addController(new GoveeController(value));
		} else {
			controller.updateWithValue(value);
		}
	};
}

class GoveeController{
	 constructor(value){
		this.id = value?.id ?? "Unknown ID";

		const packet = JSON.parse(value.response).msg;
		const response = packet.data;
		const type = packet.cmd;
		service.log(`Type: ${type}`);

		service.log(response);

		this.ip = response?.ip ?? "Unknown IP";
		this.name = response?.sku ?? "Unknown SKU";


		this.GoveeInfo = this.GetGoveeDevice(response.sku);
		this.supportDreamView = this.GoveeInfo?.supportDreamView;
		this.supportRazer = this.GoveeInfo?.supportRazer;
		this.deviceImage = this.GoveeInfo?.deviceImage;

		this.device = response.device;
		this.sku = response?.sku ?? "Unknown Govee SKU";
		this.bleVersionHard = response?.bleVersionHard ?? "Unknown";
		this.bleVersionSoft = response?.bleVersionSoft ?? "Unknown";
		this.wifiVersionHard = response?.wifiVersionHard ?? "Unknown";
		this.wifiVersionSoft = response?.wifiVersionSoft ?? "Unknown";
		this.initialized = false;

		this.DumpControllerInfo();

		if(this.name !== "Unknown") {
			this.cacheControllerInfo(this);
		}
	}

	GetGoveeDevice(sku){
		if(GoveeDeviceLibrary.hasOwnProperty(sku)){
		  return GoveeDeviceLibrary[sku];
		}

		return {
			name: "Unknown",
			supportDreamView: false,
			supportRazer: false,
			deviceImage: "https://assets.signalrgb.com/brands/products/govee_ble/icon@2x.png"
		};
	}

	DumpControllerInfo(){
		service.log(`id: ${this.id}`);
		service.log(`ip: ${this.ip}`);
		service.log(`device: ${this.device}`);
		service.log(`sku: ${this.sku}`);
		service.log(`bleVersionHard: ${this.bleVersionHard}`);
		service.log(`bleVersionSoft: ${this.bleVersionSoft}`);
		service.log(`wifiVersionHard: ${this.wifiVersionHard}`);
		service.log(`wifiVersionSoft: ${this.wifiVersionSoft}`);
		service.log(`Supports Razer: ${this.supportRazer ? 'yes': 'no'}`);
		service.log(`Supports DreamView: ${this.supportDreamView ? 'yes': 'no'}`);
	}

	updateWithValue(value){
		this.id = value.id;

		const response = JSON.parse(value.response).msg.data;

		this.ip = response?.ip ?? "Unknown IP";
		this.device = response.device;
		this.sku = response?.sku ?? "Unknown Govee SKU";
		this.bleVersionHard = response?.bleVersionHard ?? "Unknown";
		this.bleVersionSoft = response?.bleVersionSoft ?? "Unknown";
		this.wifiVersionHard = response?.wifiVersionHard ?? "Unknown";
		this.wifiVersionSoft = response?.wifiVersionSoft ?? "Unknown";

		service.updateController(this);
	}

	update(){
		if(!this.initialized){
			this.initialized = true;
			service.updateController(this);
			service.announceController(this);
		}
	}

	cacheControllerInfo(value){
		discovery.cache.Add(value.id, {
			name: value.name,
			ip: value.ip,
			id: value.id
		});
	}
}


class GoveeProtocol {

	constructor(ip, supportDreamView, supportRazer){
		this.ip = ip;
		this.port = 4003;
		this.lastPacket = 0;
		this.supportDreamView = supportDreamView;
		this.supportRazer = supportRazer;
	}

	setDeviceState(on){
		UDPServer.send(JSON.stringify({
			"msg": {
				"cmd": "turn",
				"data": {
					"value": on ? 1 : 0
				}
			}
		}));
	}

	SetBrightness(value) {
		UDPServer.send(JSON.stringify({
			"msg": {
				"cmd":"brightness",
				"data": {
					"value":value
				}
			}
		}));
	}

	SetRazerMode(enable){
		UDPServer.send(JSON.stringify({msg:{cmd:"razer", data:{pt:enable?"uwABsQEK":"uwABsQAL"}}}));
	}

	calculateXorChecksum(packet) {
		let checksum = 0;

		for (let i = 0; i < packet.length; i++) {
		  checksum ^= packet[i];
		}

		return checksum;
	}

	createDreamViewPacket(colors) {
		// Define the Dreamview protocol header
		const header = [0xBB, 0x00, 0x20, 0xB0, 0x01, colors.length / 3];
		const fullPacket = header.concat(colors);
		const checksum = this.calculateXorChecksum(fullPacket);
		fullPacket.push(checksum);

		return fullPacket;
	}

	createRazerPacket(colors) {
		// Define the Razer protocol header
		const header = [0xBB, 0x00, 0x0E, 0xB0, 0x01, colors.length / 3];
		const fullPacket = header.concat(colors);
		fullPacket.push(0); // Checksum

		return fullPacket;
	}

	SetStaticColor(RGBData){
		UDPServer.send(JSON.stringify({
			msg: {
				cmd: "colorwc",
				data: {
					color: {r: RGBData[0], g: RGBData[1], b: RGBData[2]},
					colorTemInKelvin: 0
				}
			}
		}));
		device.pause(100);
	}

	SendEncodedPacket(packet){
		const command = base64.Encode(packet);

		const now = Date.now();

		if (now - this.lastPacket > 1000) {
			UDPServer.send(JSON.stringify({
				msg: {
					cmd: "status",
					data: {}
				}
			}));
			this.lastPacket = now;
		}

		UDPServer.send(JSON.stringify({
			msg: {
				cmd: "razer",
				data: {
					pt: command,
				},
			},
		}));
	}

	SendRGB(RGBData) {

		if (this.supportDreamView) {
			const packet = this.createDreamViewPacket(RGBData);
			this.SendEncodedPacket(packet);
		} else if(this.supportRazer) {
			const packet = this.createRazerPacket(RGBData);
			this.SendEncodedPacket(packet);
		} else{
			this.SetStaticColor(RGBData.slice(0, 3));
		}
	}
}

class UdpSocketServer{
	constructor (args) {
		this.count = 0;
		/** @type {udpSocket | null} */
		this.server = null;
		this.listenPort = args?.listenPort ?? 0;
		this.broadcastPort = args?.broadcastPort ?? 4001;
		this.ipToConnectTo = args?.ip ?? "239.255.255.250";
		this.isDiscoveryServer = args?.isDiscoveryServer ?? false;
	}

	write(packet, address, port) {
		if(!this.server) {
			this.server = udp.createSocket();
		}

		this.server.write(packet, address, port);
	}

	send(packet) {
		if(!this.server) {
			this.server = udp.createSocket();
			device.log("Defining new UDP Socket so we can send data.");
		}

		this.server.send(packet);
	}

	start(){
		this.server = udp.createSocket();

		if(this.server){

			// Given we're passing class methods to the server, we need to bind the context (this instance) to the function pointer
			this.server.on('error', this.onError.bind(this));
			this.server.on('message', this.onMessage.bind(this));
			this.server.on('listening', this.onListening.bind(this));
			this.server.on('connection', this.onConnection.bind(this));
			this.server.bind(this.listenPort);
			this.server.connect(this.ipToConnectTo, this.broadcastPort);

		}
	};

	stop(){
		if(this.server) {
			this.server.disconnect();
			this.server.close();
		}
	}

	onConnection(){
		service.log('Connected to remote socket!');
		service.log("Remote Address:");
		service.log(this.server.remoteAddress(), {pretty: true});
		service.log("Sending Check to socket");

		const bytesWritten = this.server.send(JSON.stringify({
			msg: {
				cmd: "scan",
				data: {
					account_topic: "reserve",
				},
			}
		}));

		if(bytesWritten === -1){
			service.log('Error sending data to remote socket');
		}
	};

	onListenerResponse(msg) {
		service.log('Data received from client');
		service.log(msg, {pretty: true});
	}

	onListening(){
		const address = this.server.address();
		service.log(`Server is listening at port ${address.port}`);

		// Check if the socket is bound (no error means it's bound but we'll check anyway)
		service.log(`Socket Bound: ${this.server.state === this.server.BoundState}`);
	};
	onMessage(msg){
		service.log('Data received from client');
		service.log(msg, {pretty: true});

		if(this.isDiscoveryServer) {
			discovery.forceDiscovery(msg);
		}
	};
	onError(code, message){
		service.log(`Error: ${code} - ${message}`);
		//this.server.close(); // We're done here
	};
}

class IPCache{
	constructor(){
		this.cacheMap = new Map();
		this.persistanceId = "ipCache";
		this.persistanceKey = "cache";

		this.PopulateCacheFromStorage();
	}
	Add(key, value){
		if(!this.cacheMap.has(key)) {
			service.log(`Adding ${key} to IP Cache...`);

			this.cacheMap.set(key, value);
			this.Persist();
		}
	}

	Remove(key){
		this.cacheMap.delete(key);
		this.Persist();
	}
	Has(key){
		return this.cacheMap.has(key);
	}
	Get(key){
		return this.cacheMap.get(key);
	}
	Entries(){
		return this.cacheMap.entries();
	}

	PurgeCache() {
		service.removeSetting(this.persistanceId, this.persistanceKey);
		service.log("Purging IP Cache from storage!");
	}

	PopulateCacheFromStorage(){
		service.log("Populating IP Cache from storage...");

		const storage = service.getSetting(this.persistanceId, this.persistanceKey);

		if(storage === undefined){
			service.log(`IP Cache is empty...`);

			return;
		}

		let mapValues;

		try{
			mapValues = JSON.parse(storage);
		}catch(e){
			service.log(e);
		}

		if(mapValues === undefined){
			service.log("Failed to load cache from storage! Cache is invalid!");

			return;
		}

		if(mapValues.length === 0){
			service.log(`IP Cache is empty...`);
		}

		this.cacheMap = new Map(mapValues);
	}

	Persist(){
		service.log("Saving IP Cache...");
		service.saveSetting(this.persistanceId, this.persistanceKey, JSON.stringify(Array.from(this.cacheMap.entries())));
	}

	DumpCache(){
		for(const [key, value] of this.cacheMap.entries()){
			service.log([key, value]);
		}
	}
}



// eslint-disable-next-line max-len
/** @typedef { {name: string, deviceImage: string, sku: string, state: number, supportRazer: boolean, supportDreamView: boolean, ledCount: number, hasVariableLedCount?: boolean } } GoveeDevice */
/** @type {Object.<string, GoveeDevice>} */
const GoveeDeviceLibrary = {
	H6061: {
		name: "Glide Hexa Light Panels",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/c5dbf326ba8af931cb8e0b65dd38b363-pic_h6061.png",
		sku: "H6061",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H6062: {
		name: "Glide Wall Light",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/87cb406c046fb458c6d1a7079fc0023c-pic_h6062.png",
		sku: "H6062",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 29, // This can support more? 5 * Segment Count - 1?
		hasVariableLedCount: true,
	},
	H6065: {
		name: "Glide Y Lights",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/16fcb620704c3e23683e782a149be4d4-pic_h6065.png",
		sku: "H6065",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H6066: {
		name: "Glide Hexa Pro Light Panels",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/96747e10e46f7b2788cb1e708adb1d4c-pic_h6066.png",
		sku: "H6066",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H6067: {
		name: "Glide Tri Light Panels",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/6e575f82591ee04902f5f92a4f0d2301-pic_h6067.png",
		sku: "H6067",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H6609: {
		name: "Gaming Light Strip G1",
		deviceImage: "",
		sku: "H6609",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 648,
		size: [36,18],
	},
	H610A: {
		name: "Glide Lively Wall Light",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/de6825d1888767fba52136e98c5c1d84-pic_h610a.png",
		sku: "H610A",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H610B: {
		name: "Glide Music Wall Light",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/2e2d4ef6693f74f7704d3f5e6b42a554-pic_h610b.png",
		sku: "H610B",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H6087: {
		name: "RGBIC Fixture Lights",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/6b9765e90b3dbb1efd7d18855b90357a-pic_h6087.png",
		sku: "H6087",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H6056: {
		name: "Flow Plus Light Bar",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/d7606004574f941d8775e6f56b127739-pic_h6056.png",
		sku: "H6056",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 0,
		usesSubDevices: true,
		subdevices: [
			{
				name: "Flow Plus Light Bar",
				ledCount: 3,
				size: [1, 3],
				ledNames: ["Led 1", "Led 2", "Led 3"],
				ledPositions: [[0, 0], [0, 1], [0, 2]],
			},
			{
				name: "Flow Plus Light Bar",
				ledCount: 3,
				size: [1, 3],
				ledNames: ["Led 1", "Led 2", "Led 3"],
				ledPositions: [[0, 0], [0, 1], [0, 2]],
			},
		]
	},
	H6046: {
		name: "RGBIC TV Light Bars",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/456da607c09aec3228f9cf8ae36d72d2-pic_h6046.png",
		sku: "H6046",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 0,
		usesSubDevices: true,
		subdevices: [
			{
				name: "RGBIC TV Light Bars",
				ledCount: 10,
				size: [1, 10],
				ledNames: ["Led 1", "Led 2", "Led 3", "Led 4", "Led 5", "Led 6", "Led 7", "Led 8", "Led 9", "Led 10"],
				ledPositions: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [0, 7], [0, 8], [0, 9]],
			},
			{
				name: "RGBIC TV Light Bars",
				ledCount: 10,
				size: [1, 10],
				ledNames: ["Led 1", "Led 2", "Led 3", "Led 4", "Led 5", "Led 6", "Led 7", "Led 8", "Led 9", "Led 10"],
				ledPositions: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [0, 7], [0, 8], [0, 9]],
			},
		]
	},
	H6047: {
		name: "RGBIC Gaming Light Bars",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/21891e5a8b691faf341051b27f3aa237-pic_h6047.png",
		sku: "H6047",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H6051: {
		name: "Table Lamp Lite",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/f015e6f54a8866e0da126715ed459fbd-pic_h6051.png",
		sku: "H6051",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 15
	},
	H6059: {
		name: "RGB Night Light Mini",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/4f75d0c656a579ed7ed1a2c149d07425-pic_h6059.png",
		sku: "H6059",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H6052: {
		name: "RGBICWW Table Lamp",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/968a1a8fba6d5badef8bcf165e51eeb2-pic_h6052.png",
		sku: "H6052",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H61A0: {
		name: "3m RGBIC Neon Rope Lights",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/bcae6126eebd16ec544af1667569be90-pic_h61a0.png",
		sku: "H61A0",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H61A1: {
		name: "2m RGBIC Neon Rope Lights",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/4677148fa9b2569a2bc199a999e079fc-pic_h61a1.png",
		sku: "H61A1",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H61A2: {
		name: "5m RGBIC Neon Rope Lights",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/62dc52e39efdf5d2f95af407bf9f2a21-pic_h61a2.png",
		sku: "H61A2",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H61A3: {
		name: "4m RGBIC Neon Rope Lights",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/ae28b6535367606f7e94947f1d9e6b8e-pic_h61a3.png",
		sku: "H61A3",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H619A: {
		name: "5m RGBIC Pro Strip Lights",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/00d6e3f43eb6e1df50ccbfa84054d7db-pic_h619a.png",
		sku: "H619A",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H619B: {
		name: "7.5m RGBIC Pro Strip Lights",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/52131582bfb2417cf8ac7c06635f695d-pic_h619b.png",
		sku: "H619B",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H619C: {
		name: "10m RGBIC Pro Strip Lights",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/f9154fdcba85da2c930f899cb3ea037e-pic_h619c.png",
		sku: "H619C",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H619D: {
		name: "2*7.5m RGBIC Pro Strip Lights",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/3bb6c520b09205815743a1564998c041-pic_h619d.png",
		sku: "H619D",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H619E: {
		name: "2*10m RGBIC Pro Strip Lights",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/1957e01b6147810efbf23a5eb08e7791-pic_h619e.png",
		sku: "H619E",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H619Z: {
		name: "3m RGBIC Pro Strip Lights",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/6ea5b46c846e1d958dc50141019077d7-pic_h619z.png",
		sku: "H619Z",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 12
	},
	H61B2: {
		name: "3m RGBIC Neon TV Backlight",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/5a224ccd2cc850d8b554df2ff0e5a129-pic_h61b2.png",
		sku: "H61B2",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H61C2: {
		name: "RGBIC LED Neon Rope Lights for Desks",
		deviceImage: "",
		sku: "H61C2",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 16
	},
	H61C3: {
		name: "RGBIC LED Neon Rope Lights for Desks",
		deviceImage: "",
		sku: "H61C3",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 16
	},
	H61E0: {
		name: "LED Strip Light M1",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/5b311c4dd19e17c6eeaf5e662e66904d-pic_h61e1.png",
		sku: "H61E0",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 20
	},
	H61E1: {
		name: "LED Strip Light M1",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/5b311c4dd19e17c6eeaf5e662e66904d-pic_h61e1.png",
		sku: "H61E1",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H6172: {
		name: "10m Outdoor RGBIC Strip Light",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/51e20e4b042edb3a4cb74224b5d23ee7-pic_h6172.png",
		sku: "H6172",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H615A: {
		name: "5m RGB Strip Light",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/c98cbaaa69b377ee063034857807f3be-pic_h615a.png",
		sku: "H615A",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H6110: {
		name: "2*5m MultiColor Strip Lights",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/269cb9958cd5543e405b76f04b75b706-pic_h6110.png",
		sku: "H6110",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H618A: {
		name: "5m RGBIC Basic Strip Light",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/1d2461103cb2eafec6a93b8d8e702d22-pic_h618a.png",
		sku: "H618A",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1,
		usesSubDevices: true,
		subdevices: [
			{
				name: "RGBIC Basic Strip Light",
				ledCount: 10,
				size: [1, 10],
				ledNames: ["Led 1", "Led 2", "Led 3", "Led 4", "Led 5", "Led 6", "Led 7", "Led 8", "Led 9", "Led 10"],
				ledPositions: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [0, 7], [0, 8], [0, 9]],
			},
		]
	},
	H618C: {
		name: "10m RGBIC Basic Strip Light",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/453fc13d798f23c94feda52834f73813-pic_h618c.png",
		sku: "H618C",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H618E: {
		name: "2*10m RGBIC Bassic Strip Lights",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/e843bfe60f9c2c161358a050bb50c3c1-pic_h618e.png",
		sku: "H618E",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H6117: {
		name: "2*5m RGBIC Strip Lights",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/c058906f9377b63e5fdd120830148562-pic_h6117.png",
		sku: "H6117",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H61A5: {
		name: "10m RGBIC Neon Rope Lights",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/06cff034fc0b736f45812ea294bdbedb-pic_h61a5.png",
		sku: "H61A5",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 30
	},
	H615B: {
		name: "10m RGB Strip Light",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/4d980e98e155f851f35f0d608d3d1587-pic_h615b.png",
		sku: "H615B",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H615C: {
		name: "15m RGB Strip Light",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/7bf934361a4114103c460d04fe8b67a8-pic_h615c.png",
		sku: "H615C",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H618F: {
		name: "2*15m RGBIC LED Strip Light",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/ac331687ef8b9fdcd7e77156f9aadb91-pic_h618f.png",
		sku: "H618F",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H6072: {
		name: "RGBICWW Floor Lamp",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/1edf77ca5bb565da3d220db6a2d175c2-pic_h6072.png",
		sku: "H6072",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H6073: {
		name: "Smart RGB Floor Lamp",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/ae9ae475d463236be32ad4818d760e0f-pic_h6073.png",
		sku: "H6073",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H6076: {
		name: "RGBICW Floor Lamp Basic",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/241e8ee823f9c2a2057ca3668be7281e-pic_h6076.png",
		sku: "H6076",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H7060: {
		name: "4 Pack RGBIC Flood Lights",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/f7817d0f6284c5403324e1268beed798-pic_h7060.png",
		sku: "H7060",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H7061: {
		name: "2 Pack RGBIC Flood Lights",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/aae0bc2498289d61b4ecc0f798e33759-pic_h7061.png",
		sku: "H7061",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H7062: {
		name: "6 Pack RGBIC Flood Lights",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/deals-img/aa27302d9bada483b7e99b3a8a4930a8-pic_h7062.png",
		sku: "H7062",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H70B1: {
		name: "Curtain Lights",
		deviceImage: "https://d1f2504ijhdyjw.cloudfront.net/posting-img/db7c2bd49b5dc177a4010f773f7e1e32-70b1%E5%8C%85%E8%A3%85.png",
		sku: "H70B1",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 10
	},
	H61D5: {
		name: "RGBIC Neon Lights 2",
		deviceImage: "",
		sku: "H61D5",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 7
	},
	H6168: {
		name: "RGBIC TV Light Bars",
		deviceImage: "",
		sku: "H6168",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 0,
		usesSubDevices: true,
		subdevices: [
			{
				name: "RGBIC TV Light Bars",
				ledCount: 10,
				size: [1, 10],
				ledNames: ["Led 1", "Led 2", "Led 3", "Led 4", "Led 5", "Led 6", "Led 7", "Led 8", "Led 9", "Led 10"],
				ledPositions: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [0, 7], [0, 8], [0, 9]],
			},
			{
				name: "RGBIC TV Light Bars",
				ledCount: 10,
				size: [1, 10],
				ledNames: ["Led 1", "Led 2", "Led 3", "Led 4", "Led 5", "Led 6", "Led 7", "Led 8", "Led 9", "Led 10"],
				ledPositions: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [0, 7], [0, 8], [0, 9]],
			},
		]
	}
};