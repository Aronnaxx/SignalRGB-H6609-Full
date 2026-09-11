import udp from "@SignalRGB/udp";
export function Name() { return "Govee"; }
export function Version() { return "1.0.0"; }
export function Type() { return "network"; }
export function Publisher() { return "WhirlwindFX"; }
export function Size() { return [22, 1]; }

// False, with SetIsSubdeviceController called per device instead. Only 5 of the ~68 library
// entries are built from separate physical pieces; declaring every Govee light a subdevice
// controller made bulbs and single-segment strips ask to be configured before they would light.
export function SubdeviceController() { return false; }
/* global
controller:readonly
discovery: readonly
shutdownColor:readonly
LightingMode:readonly
forcedColor:readonly
TurnOffOnShutdown:readonly
protocolSelect:readonly
blendSegments:readonly
variableLedCount:readonly
streamKeepalive:readonly
statusQuery:readonly
forceReconnect:readonly
*/
export function ControllableParameters() {
	return [
		{property:"shutdownColor", group:"lighting", label:"Shutdown Color", description: "This color is applied to the device when the System, or SignalRGB is shutting down", min:"0", max:"360", type:"color", default:"#000000"},
		{property:"LightingMode", group:"lighting", label:"Lighting Mode", description: "Determines where the device's RGB comes from. Canvas will pull from the active Effect, while Forced will override it to a specific color", type:"combobox", values:["Canvas", "Forced"], default:"Canvas"},
		{property:"forcedColor", group:"lighting", label:"Forced Color", description: "The color used when 'Forced' Lighting Mode is enabled", min:"0", max:"360", type:"color", default:"#009bde"},
		{property:"TurnOffOnShutdown", group:"settings", label:"Turn off when ignored", description: "This turns off the device when it is ignored or disabled, and when the app shuts down", type:"boolean", default:"false"},
		{property:"protocolSelect", group:"settings", label:"Protocol", description: "Determines which protocol will be used to control the device. Auto picks the best protocol this device is known to support, and is the right choice unless you're troubleshooting. (Not all protocols works on a device)", type:"combobox", values:["Auto", "Dreamview", "RazerV1", "RazerV2", "Static"], default:"Auto"},
		{property:"blendSegments", group:"settings", label:"Blend Between Segments", description: "Lets the device fade between the colors we send instead of applying each one to its own segment. Auto follows what the device library says. Softer on a strip, wrong on anything built from separate physical pieces like a curtain, where it blends across a gap that is not there in the light.", type:"combobox", values:["Auto", "On", "Off"], default:"Auto"},
		{property:"forceReconnect", group:"settings", label:"Force Reconnect", description: "Toggle this switch to immediately reset the UDP socket and force a reconnect to the device", type:"boolean", default:"false"},
		// TEMPORARY, both of these. They exist to settle whether stream mode really auto-disables in
		// the firmware, which is the only thing that ever justified paying a dropped frame on a timer.
		// Remove both once that is known -- see the comment on MaintainStreamingMode.
		{property:"streamKeepalive", group:"settings", label:"Stream Keepalive (test)", description: "How stream mode is kept alive. Sending the stream mode command costs a dropped frame on the device, so 'On loss only' sends it just when the device stops answering. 'Never' never re-sends it after startup. 'Timer 40s' is the old behaviour, kept only so the two can be compared on the bench.", type:"combobox", values:["On loss only", "Never", "Timer 40s"], default:"On loss only"},
		{property:"statusQuery", group:"settings", label:"Status Query (test)", description: "Whether to send the once-a-second status query in among the colour frames. Its replies are what tell us the device is still listening, but the query is also the main suspect for knocking the device out of stream mode in the first place. Turning it off removes both.", type:"boolean", default:"true"},
	];
}

/** @type {GoveeProtocol} */
let govee;

// Matches what shipped before the components rewrite. A device we cannot identify gets a
// modest strip rather than a large one: too few LEDs renders a coarse version of the effect,
// while too many silently pushes past what the device accepts -- and above roughly 20 some
// devices blank entirely rather than clamping.
const UnknownSkuLedCount = 20;

/** The device's LED layout, as handed to setControllableLeds. Rebuilt by SetLedCount whenever
 * the count changes, and the source of truth for how many colors go on the wire. */
let ledCount = 0;
let ledNames = [];
let ledPositions = [];

/** Populated only for library entries with usesSubDevices -- devices built from separate
 * physical pieces, where each piece is placed on the canvas independently.
 * @type {{id: string, name: string, ledCount: number, size: number[], ledNames: string[], ledPositions: number[][]}[]} */
let subdevices = [];

/** Protocol used while protocolSelect is left on "Auto". Resolved per device from the
 * library, so a device only ever gets a protocol it's known to support. */
let autoProtocol = "Static";

/** Reset per Initialize so the first outbound frame is logged once. Initialize completing
 * does not mean Render is running, and the two failure modes look identical on the device. */
let loggedFirstFrame = false;

/** Frames since Initialize. Logged periodically so a render loop that never starts, or one
 * that starts and later stops, is visible instead of silent. */
let renderCount = 0;

/** Whether the socket has been seen connected since Initialize, so the setup commands can be
 * asserted once it actually is. */
let sawConnectedSocket = false;

/** So the "not initialized yet" warning is logged once rather than every frame. */
let loggedMissingProtocol = false;

/** Whether this device should let the firmware fade between the colors we send. Seeded from the
 * library per device, since whether blending helps depends on the device being one continuous run
 * of LEDs rather than several separate pieces. */
let blendByDefault = true;

/** When the device last answered us. Every status reply updates it, and silence is the only
 * evidence we have that stream mode was lost. Zero means it has never answered, so nothing is
 * judged lost before the first reply arrives. */
let lastStatusReply = 0;

/** How long the device may go unanswering before stream mode is treated as lost. The status query
 * goes out about once a second, so this is several missed replies rather than one dropped
 * datagram -- UDP loses the odd packet and that is not worth a dropped frame. */
const StreamLostAfter = 5000;

/** So the state of the liveness channel is logged on transitions rather than once a second. */
let loggedFirstStatusReply = false;
let loggedNoStatusReplies = false;
let streamLooksLost = false;

/** Only reachable through the "Timer 40s" test setting. Not a path worth keeping -- see
 * MaintainStreamingMode. */
const StreamingAssertInterval = 40000;
let lastStreamingAssert = 0;

export function Initialize(){
	loggedFirstFrame = false;
	renderCount = 0;
	sawConnectedSocket = false;
	lastStreamingAssert = 0;
	lastStatusReply = 0;
	loggedFirstStatusReply = false;
	loggedNoStatusReplies = false;
	streamLooksLost = false;
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
	});

	UDPServer.start();
	//Establish a new udp server. This is now required for using udp.send.

	// The device answers us, and until now nothing listened. Its replies are the only way to tell a
	// device that is still streaming from one that has silently stopped accepting frames.
	UDPServer.setCallbackFunction(OnDeviceResponse);

	// Subdevices survive a reload, so they have to be torn down before the layout is rebuilt or
	// a device accumulates a fresh set on every Initialize.
	ClearSubdevices();
	fetchDeviceInfoFromTableAndConfigure();

	govee = new GoveeProtocol(controller.ip, controller.supportDreamView, controller.supportRazer);

	govee.setDeviceState(true);
	govee.SetStreamingMode(true);
}

export function Render(){
	// Initialize assigns govee only after fetchDeviceInfoFromTableAndConfigure has run, so if that
	// throws -- or Render is reached before Initialize at all -- govee is undefined and every call
	// below fails with "Cannot read property of undefined". Bail instead of throwing once per frame.
	if(govee === undefined){
		if(!loggedMissingProtocol){
			loggedMissingProtocol = true;
			device.log("Render called before the device finished initializing. Nothing to send yet.");
		}

		return;
	}

	// Uncomment to trace the render loop. Distinguishes a loop that never starts from one
	// that starts and later stops -- neither is otherwise visible, since a device holds its
	// last color rather than going dark.
	// if(renderCount % 300 === 0){
	// 	device.log(`Render tick ${renderCount}.`);
	// }

	// If the socket was disconnected or had an error, attempt to reconnect and pause Render
	if(UDPServer !== undefined && !UDPServer.connected){
		sawConnectedSocket = false;
		UDPServer.attemptReconnect();
		device.pause(50);
		return;
	}

	// Initialize starts the socket and then sends the setup commands straight away, before
	// connect() has reported back, so they can go out on a socket that is not ready yet.
	// Watch for the connection landing instead and assert them then. A flag check per frame,
	// no blocking, and it works no matter how long the socket takes.
	if(!sawConnectedSocket && UDPServer !== undefined && UDPServer.connected){
		sawConnectedSocket = true;
		device.log("Socket connected! Initializing device stream...");
		govee.setDeviceState(true);
		govee.SetStreamingMode(true);
		lastStatusReply = Date.now();
	}

	MaintainStreamingMode();

	renderCount++;

	govee.SendRGB();
	device.pause(10);
}

/** Re-asserts stream mode, but only where there is a reason to.
 *
 * Every 0xB1 costs a dropped frame on the device -- confirmed on hardware -- and it cannot be
 * papered over by resending the colour frame, because Render already sends one in the same tick
 * with no pause between them and the device drops it anyway. So the device is discarding whatever
 * arrives while it re-enters stream mode, which makes the interval untunable: the only acceptable
 * number of scheduled asserts is none. That is what shipped as flicker twice, at 150 frames and
 * then at 40 seconds.
 *
 * The evidence that stream mode was lost is the device going quiet. It answers the status query
 * SendEncodedPacket sends, so replies arriving mean it is still on the other end; silence past
 * StreamLostAfter means it is not, and that is the one case worth a dropped frame.
 *
 * The two other modes are temporary, and exist to settle whether the firmware really has the one
 * minute auto-disable the protocol reference claims. It has never been measured, and the bench
 * result it rests on has a competing explanation -- the status query itself dropping the device out
 * of stream mode -- so both halves have to be switchable to tell them apart. Delete them, and the
 * settings that drive them, once that is known. */
function MaintainStreamingMode(){
	if(streamKeepalive === "Never"){
		return;
	}

	// The old behaviour, kept only for bench comparison. Flashes every 40 seconds by design.
	if(streamKeepalive === "Timer 40s"){
		const now = Date.now();

		if(now - lastStreamingAssert > StreamingAssertInterval){
			lastStreamingAssert = now;
			govee.SetStreamingMode(true);
		}

		return;
	}

	// Nothing to judge while the query that produces the replies is switched off. Assert on connect
	// is all that is left in that configuration, which is the point of being able to switch it off.
	if(!statusQuery){
		return;
	}

	if(lastStatusReply === 0){
		// Never answered at all. Worth saying once, because it means this device gives us no
		// liveness signal and the protocol's status command may simply be named something else --
		// the LAN API documents devStatus, and we send "status".
		if(!loggedNoStatusReplies && renderCount > 600){
			loggedNoStatusReplies = true;
			device.log("Device has never answered a status query, so stream mode cannot be watched on it. It will only be asserted on connect.");
		}

		return;
	}

	const timeSinceReply = Date.now() - lastStatusReply;
	if(timeSinceReply < StreamLostAfter){
		return;
	}

	// If the device has gone silent for over 15 seconds, re-asserting streaming mode alone
	// has not recovered it. Force a fresh socket reconnect.
	if(timeSinceReply > 15000 && UDPServer !== undefined){
		device.log(`Device silent for ${timeSinceReply}ms. Forcing socket reconnection...`);
		lastStatusReply = Date.now();
		sawConnectedSocket = false;
		UDPServer.reconnect();
		return;
	}

	device.log(`Device has not answered for ${StreamLostAfter}ms. Treating stream mode as lost and re-asserting it once.`);
	streamLooksLost = true;
	// Restart the clock, or a device that stays quiet gets an assert every single frame.
	lastStatusReply = Date.now();
	govee.SetStreamingMode(true);
}

/** Handles a reply from the device. Nothing listened to these before -- setCallbackFunction existed
 * and nothing ever called it -- so a device that had silently stopped accepting frames looked
 * identical to one that was streaming fine.
 *
 * The valuable part is simply that a reply arrived. Reading the body is a bonus: a device that has
 * been turned off elsewhere will not show our frames whatever we send it. */
function OnDeviceResponse(msg){
	const now = Date.now();
	const silence = lastStatusReply === 0 ? 0 : now - lastStatusReply;

	lastStatusReply = now;

	if(!loggedFirstStatusReply){
		loggedFirstStatusReply = true;
		device.log("Device is answering status queries, so stream mode can be watched instead of re-asserted blindly.");
	}

	if(streamLooksLost){
		streamLooksLost = false;
		device.log(`Device is answering again after ${silence}ms of silence.`);
	}

	// The reply may arrive as the raw datagram or wrapped the way discovery responses are, so accept
	// either rather than assuming a shape we have not confirmed on this socket.
	const payload = typeof msg === "string" ? msg : msg?.response;

	if(payload === undefined){
		return;
	}

	let reply;

	try{
		reply = JSON.parse(payload);
	}catch(e){
		device.log(`Could not parse a reply from the device: ${e}`);

		return;
	}

	if(reply?.msg?.data?.onOff === 0){
		device.log("Device reports it is switched off. It will not show streamed frames until it is on again.");
	}
}

export function Shutdown(SystemSuspending){
	// Shutdown runs on paths where Initialize never completed -- a device that failed to come up,
	// or a reload racing teardown -- so govee can be undefined here. Throwing in Shutdown is
	// particularly bad: the host discards the result on the app-exit path, so it surfaces as the
	// shutdown color silently not applying rather than as an error.
	if(govee === undefined){
		return;
	}

	// Hand control back to the device first. Anything streamed at it before this point is
	// discarded along with the stream, which is why the shutdown color never stuck.
	govee.SetStreamingMode(false);

	if(TurnOffOnShutdown){
		govee.setDeviceState(false);

		return;
	}

	// colorwc sets the device's own state, so it survives us going away. Color properties
	// arrive as objects rather than hex strings, so the conversion goes through
	// createColorArray like everywhere else. SendStaticColor skips SetStaticColor's
	// render-loop pause, which has no business running while the device is being torn down.
	const color = SystemSuspending ? "#000000" : shutdownColor;
	govee.SendStaticColor(device.createColorArray(color, 1, "Inline"));
}

function fetchDeviceInfoFromTableAndConfigure() {
	if(!GoveeDeviceLibrary.hasOwnProperty(controller.sku)){
		device.log(`SKU (${controller.sku}) not found on the library, using ${UnknownSkuLedCount} LEDs!`);
		device.setName(`Govee: ${controller.sku}`);
		// An unrecognised device gets the one protocol every Govee light accepts.
		autoProtocol = "Static";
		device.SetIsSubdeviceController(false);
		SetLedCount(UnknownSkuLedCount);

		return;
	}

	const GoveeDeviceInfo = GoveeDeviceLibrary[controller.sku];
	blendByDefault = GoveeDeviceInfo.blendSegments ?? true;
	device.setName(`Govee ${GoveeDeviceInfo.sku} - ${GoveeDeviceInfo.name}`);
	autoProtocol = GetAutoProtocol(GoveeDeviceInfo);
	device.log(`Auto protocol for ${GoveeDeviceInfo.sku} resolved to ${autoProtocol}.`);

	// The library count is a best guess for devices sold in several lengths, so those expose it as
	// a setting. This is the only way a user can correct a wrong count, which is why it has to be
	// wired to something -- the flag sat declared and unread while components were the only path.
	if(GoveeDeviceInfo.hasVariableLedCount){
		device.addProperty({property: "variableLedCount", group: "settings", label: "Segment Count", description: "How many segments this device has. The library ships a default per SKU, but these are sold in several lengths, so correct it here if the effect does not reach the end of the device.", type: "number", min: 1, max: 60, default: GoveeDeviceInfo.ledCount, step: 1});
		SetLedCount(variableLedCount);
	}else{
		ConfigureDevice(GoveeDeviceInfo);
		device.removeProperty("variableLedCount");
	}
	// Only devices genuinely built from separate physical pieces become subdevice controllers, so
	// each piece can be placed on the canvas on its own. Everything else is one continuous run and
	// is rendered from the device layout above, with nothing for the user to configure.
	if(GoveeDeviceInfo.usesSubDevices){
		device.SetIsSubdeviceController(true);

		for(const subdevice of GoveeDeviceInfo.subdevices){
			CreateSubDevice(subdevice);
		}
	}else{
		device.SetIsSubdeviceController(false);
	}
}

function ConfigureDevice(GoveeDeviceInfo){
	ledCount = GoveeDeviceInfo.ledCount;

	if(GoveeDeviceInfo.ledPositions && GoveeDeviceInfo.size){
		ledPositions = GoveeDeviceInfo.ledPositions;
		ledNames = GoveeDeviceInfo.ledNames || Array.from({length: ledCount}, (_, i) => `Led ${i + 1}`);
		device.setSize(GoveeDeviceInfo.size);
	}else{
		CreateLedMap();
		device.setSize([ledCount, 1]);
	}

	device.setControllableLeds(ledNames, ledPositions);
}

/** Called by the host when the user changes the Segment Count setting on a device that has one. */
export function onvariableLedCountChanged(){
	SetLedCount(variableLedCount);
}

/** Called by the host when the user toggles the Force Reconnect setting. */
export function onforceReconnectChanged(){
	device.log("User triggered Force Reconnect.");
	sawConnectedSocket = false;
	lastStatusReply = Date.now();
	if(UDPServer !== undefined){
		UDPServer.reconnect();
	}
}

function GetAutoProtocol(GoveeDeviceInfo){
	if(GoveeDeviceInfo.supportDreamView){
		return "Dreamview";
	}

	if(GoveeDeviceInfo.supportRazer){
		return "RazerV1";
	}

	// Everything else only ever responded to plain colorwc commands.
	return "Static";
}

/** Whether to let the firmware fade between the colors we send. Auto defers to the library, since
 * whether blending helps depends on the device being one continuous run of LEDs rather than
 * several separate pieces. */
function ShouldBlend(){
	if(blendSegments === "On"){
		return true;
	}

	if(blendSegments === "Off"){
		return false;
	}

	return blendByDefault;
}

/** Gives the device a real LED layout. This is what lets a device light straight after being
 * linked: the host can map the canvas onto it without the user assigning anything first. */
function SetLedCount(count){
	ledCount = count;

	CreateLedMap();
	device.setSize([ledCount, 1]);
	device.setControllableLeds(ledNames, ledPositions);
}

/** A single horizontal run. Every DreamView device addresses its segments as one ordered
 * sequence, so the wire order is the layout order and there is nothing cleverer to do here. */
function CreateLedMap(){
	ledNames = [];
	ledPositions = [];

	for(let i = 0; i < ledCount; i++){
		ledNames.push(`Led ${i + 1}`);
		ledPositions.push([i, 0]);
	}
}

function ClearSubdevices(){
	for(const subdevice of device.getCurrentSubdevices()){
		device.removeSubdevice(subdevice);
	}

	subdevices = [];
}

function CreateSubDevice(subdevice){
	const count = device.getCurrentSubdevices().length;
	subdevice.id = `${subdevice.name} ${count + 1}`;
	device.createSubdevice(subdevice.id);

	device.setSubdeviceName(subdevice.id, subdevice.name);
	device.setSubdeviceImage(subdevice.id, controller.deviceImage);
	device.setSubdeviceSize(subdevice.id, subdevice.size[0], subdevice.size[1]);
	device.setSubdeviceLeds(subdevice.id, subdevice.ledNames, subdevice.ledPositions);

	subdevices.push(subdevice);
}

/** The single color every LED takes this frame, or undefined to read the canvas per LED.
 *
 * Color properties arrive from the host as objects rather than hex strings, so this goes through
 * createColorArray instead of parsing hex -- the reason the old hexToRgb helper is not restored
 * along with the rest of this. */
function FixedFrameColor(overrideColor){
	if(overrideColor){
		return device.createColorArray(overrideColor, 1, "Inline");
	}

	if(LightingMode === "Forced"){
		return device.createColorArray(forcedColor, 1, "Inline");
	}

	return undefined;
}

/** Colors for a device rendered as one continuous run, in layout order. */
function GetDeviceRGB(overrideColor){
	const RGBData = new Array(ledCount * 3).fill(0);
	const fixedColor = FixedFrameColor(overrideColor);

	for(let i = 0; i < ledPositions.length; i++){
		const ledPosition = ledPositions[i];
		const color = fixedColor ?? device.color(ledPosition[0], ledPosition[1]);

		RGBData[i * 3] = color[0];
		RGBData[i * 3 + 1] = color[1];
		RGBData[i * 3 + 2] = color[2];
	}

	return RGBData;
}

/** Colors for a device built from separate pieces, in subdevice order, which is the order the
 * device chains them on the wire.
 *
 * The index runs across all subdevices rather than restarting inside each. The version that
 * shipped before the components rewrite restarted it, so with two identically shaped pieces --
 * which is every such entry in the library -- the second overwrote the first and only half the
 * device's colors were ever sent. */
function GetRGBFromSubdevices(overrideColor){
	const RGBData = [];
	const fixedColor = FixedFrameColor(overrideColor);
	let index = 0;

	for(const subdevice of subdevices){
		for(const ledPosition of subdevice.ledPositions){
			const color = fixedColor ?? device.subdeviceColor(subdevice.id, ledPosition[0], ledPosition[1]);

			RGBData[index * 3] = color[0];
			RGBData[index * 3 + 1] = color[1];
			RGBData[index * 3 + 2] = color[2];
			index++;
		}
	}

	return RGBData;
}

// -------------------------------------------<( Discovery Service )>--------------------------------------------------
let UDPServer;

export function DiscoveryService() {
	this.IconUrl = "https://assets.signalrgb.com/brands/govee/logo.png";
	this.firstRun = true;

	this.Initialize = function(){
		service.log("Searching for Govee network devices...");
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
			
			this.CreateControllerDevice(value);
			this.checkCachedDevice(value.ip);

			// Nothing to link. A cached device is one the user has already accepted, so it is adopted
			// unless they explicitly ignored it, and announcing it is announce()'s job on the Update
			// tick that follows this loop. This used to call link() here, which announced a second
			// time and so listed every accepted device twice.
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
			service.log("Clearing inactive devices Sockets. All cached devices should have responded by now if they were online.");

			for(const [key, value] of this.activeSockets.entries()){
				service.log(`Clearing Socket for IP: [${key}]`);
				value.stop();
				this.activeSockets.delete(key);
				//Clear would be more efficient here, however it doesn't kill the socket instantly.
				//We instead would be at the mercy of the GC.
			}
		}
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

	this.Discovered = function(value) {
		const response	= JSON.parse(value.response);

		// Check if the response packet has the "scan" response from Govee
		if(response.msg.cmd != "scan"){
			return;
		}

		// Check if the response packet has the ip field in the response from Govee
		const isValid = response.msg.data.hasOwnProperty("ip");

		if(!isValid){
			service.log(`Potential Govee device ${response.msg.data.sku} found at ${value.ip} discarded since it's missing an IP field. If this is a Matter device, is not supported yet.`);
			service.log(response.msg.data)
			return;
		}

		// Only log the find once, but always fall through to CreateControllerDevice so a
		// cached device whose controller went missing is rebuilt on the next scan.
		if(!this.cache.Has(value.id)){
			service.log(`Govee device ${response.msg.data.sku} discovered at ${value.ip}!`);
		}

		this.CreateControllerDevice(value);
	};

	this.forceDiscovery = function(value) {
		this.Discovered(value);
	};

	this.purgeIPCache = function() {
		this.cache.PurgeCache();
	};

	this.Update = function(){

		if(this.firstRun){
			this.LoadCachedDevices();
			this.firstRun = false;
		}

		for(const cont of service.controllers){
			cont.obj.update();
		}

		this.clearSockets();
		this.CheckForDevices();
	};

	this.getSocket = function(key) {
		return this.activeSockets.get(key);
	};

	this.Shutdown = function(){

	};

	this.remove = function(controllerObj = false){

		if (controllerObj) {
			service.log(`Stopping UDP Socket for ${controllerObj.ip}`);
			const udpSocket = this.getSocket(controllerObj.ip);
			if(udpSocket){
				udpSocket.stop();
				this.activeSockets.delete(controllerObj.ip);
			}

			service.log(`Removing from cache: ${controllerObj.id}`);
			this.cache.Remove(controllerObj.id)
			
			service.log(`Removing controller: ${controllerObj.id}`);
			service.suppressController(controllerObj);
			service.removeController(controllerObj);
		} else {
			this.cache.PurgeCache();
			const cachedDevices = this.cache.Entries()
			console.log(cachedDevices);
	
			for(const [key, value] of cachedDevices){
				service.log(`Removing Cached Device: [${key}: ${JSON.stringify(value)}]`);
				service.suppressController(value);
				service.removeController(value);
			}

			this.cache.DumpCache();
		}

	};

	this.CreateControllerDevice = function(value){
		// Cache entries are keyed by their own id, so going through the cache to find the
		// controller id is a round trip to the same value. Ask the service directly.
		const controller = service.getController(value.id);

		if(controller === undefined){
			service.log(`No controller found for ${value.id}, creating one!`);
			service.addController(new GoveeController(value));
		}else{
			controller.updateWithValue(value);
		}
	};

	/** Undoes an ignore. There is no such thing as linking a Govee light: the LAN API is
	 * unauthenticated UDP on port 4003 and nothing is ever negotiated with the device, so the only
	 * state a user can meaningfully set is whether we leave it alone. This was called link(), and
	 * the button for it said "Link", which described a handshake that does not exist. */
	this.restore = function(controllerObj){
		service.log(`Restoring controller: ${controllerObj.id}`);

		const controller = service.getController(controllerObj.id);

		if(controller === undefined){
			service.log(`Cannot restore ${controllerObj.id}, no controller exists for it.`);

			return;
		}

		controller.ignored = false;

		// Update controller
		controller.updateWithValue(controller);

		// Announced directly rather than through announce(), which has already run for this
		// controller and would correctly refuse to run again. This is the user asking by name.
		service.announceController(controller);

		// Update cache
		this.cacheControllerInfo(controller);

		service.log(`Restored controller: ${controller.id}`);
	}

	/** Tells us to leave a device alone. The only real state in here -- see restore(). */
	this.ignore = function(controllerObj) {
		service.log(`Ignoring controller: ${JSON.stringify(controllerObj)}`);

		const controller = service.getController(controllerObj.id);

		if(controller === undefined){
			service.log(`Cannot ignore ${controllerObj.id}, no controller exists for it.`);

			return;
		}

		// Sockets are keyed by IP, not by controller id.
		service.log(`Stopping UDP Socket for ${controllerObj.ip}`);
		const udpSocket = this.getSocket(controllerObj.ip);
		if(udpSocket){
			udpSocket.stop();
			this.activeSockets.delete(controllerObj.ip);
		}

		controller.ignored = true;

		controller.updateWithValue(controller);
		service.suppressController(controller);

		// Update cache
		this.cacheControllerInfo(controller);
	}

	this.cacheControllerInfo = function(value) {
		discovery.cache.Add(
			value.id, {
				id: value.id,
				ignored: value.ignored,
				ip: value.ip,
				name: value.sku,
				GoveeInfo: value.GoveeInfo,
				supportDreamView: value.GoveeInfo.supportDreamView,
				supportRazer: value.GoveeInfo.supportRazer,
				deviceImage: value.GoveeInfo.deviceImage,
				device: value.device,
				sku: value.sku,
				bleVersionHard: value.bleVersionHard,
				bleVersionSoft: value.bleVersionSoft,
				wifiVersionHard: value.wifiVersionHard,
				wifiVersionSoft: value.wifiVersionSoft,
				initialized: value.initialized
			}
		);
	}
}

/** Reads a controller's ignore flag, converting entries written before it was called that.
 *
 * The flag used to be stored as "paired", the inverse of this one, and it never meant pairing --
 * ignoring a device wrote false and nothing ever wrote true except a Link button for a handshake
 * that does not exist. Old entries are converted rather than dropped, or every device anyone had
 * ignored reappears the first time they run this build.
 *
 * Absent everywhere means not ignored, which is the right default: a device the user has not spoken
 * about is one we adopt. */
function ResolveIgnored(value, id){
	const cached = discovery.cache.Get(id);

	if(value?.ignored !== undefined){
		return value.ignored;
	}

	if(cached?.ignored !== undefined){
		return cached.ignored;
	}

	if(value?.paired !== undefined){
		return value.paired === false;
	}

	if(cached?.paired !== undefined){
		return cached.paired === false;
	}

	return false;
}

class GoveeController{
	 constructor(value){
		this.id = value?.id ?? "Unknown ID";
		// Discovery responses carry no ignore state, and this constructor persists straight to the
		// cache below. Without the cache fallback a scan reply that arrives before the cached devices
		// load rebuilds the controller as not-ignored and writes that over the stored flag, so a
		// device the user had ignored comes back on startup.
		this.ignored = ResolveIgnored(value, this.id);

		let response;

		// Handle discovery or cached device
		if (value.response) {
			const packet = JSON.parse(value.response).msg;
			response = packet.data;
		} else {
			response = value
		}

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

		if(this.name !== "Unknown SKU") {
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
		// Discovery responses carry no ignore state, so only take it when it is actually present.
		// Assigning it blindly un-ignored the device on every scan reply. Older cache entries carry
		// the inverse under "paired", so accept that too rather than silently keeping the default.
		if(value?.ignored !== undefined){
			this.ignored = value.ignored;
		}else if(value?.paired !== undefined){
			this.ignored = value.paired === false;
		}

		let response;

		// Handle discovery or cached device
		if (value.response) {
			response = JSON.parse(value.response).msg.data;
		} else {
			response = value
		}

		this.ip = response?.ip ?? "Unknown IP";
		this.device = response.device;
		this.sku = response?.sku ?? "Unknown Govee SKU";
		this.bleVersionHard = response?.bleVersionHard ?? "Unknown";
		this.bleVersionSoft = response?.bleVersionSoft ?? "Unknown";
		this.wifiVersionHard = response?.wifiVersionHard ?? "Unknown";
		this.wifiVersionSoft = response?.wifiVersionSoft ?? "Unknown";

		service.updateController(this);
	}

	/** Promotes this controller to a device, once and only once.
	 *
	 * Both the discovery Update tick and the old link path wanted to do this, and announcing twice
	 * puts the device in SignalRGB's list twice -- which is why an accepted device showed up as two
	 * identical tiles while an ignored one showed up as one. The guard belongs on the controller
	 * rather than at either call site, because neither can know what the other already did. */
	announce(){
		if(this.initialized){
			return;
		}

		this.initialized = true;
		service.updateController(this);

		// An ignored device keeps its controller, so it can be restored from the interface, but is
		// never promoted to a device. Announcing it regardless is why ignoring one did not survive a
		// restart: the controller was rebuilt un-suppressed and nothing put it back.
		if(this.ignored){
			return;
		}

		service.announceController(this);
	}

	update(){
		this.announce();
	}

	cacheControllerInfo(value){
		discovery.cache.Add(
			value.id, {
				id: value.id,
				ignored: value.ignored,
				ip: value.ip,
				name: value.sku,
				GoveeInfo: value.GoveeInfo,
				supportDreamView: value.GoveeInfo.supportDreamView,
				supportRazer: value.GoveeInfo.supportRazer,
				deviceImage: value.GoveeInfo.deviceImage,
				device: value.device,
				sku: value.sku,
				bleVersionHard: value.bleVersionHard,
				bleVersionSoft: value.bleVersionSoft,
				wifiVersionHard: value.wifiVersionHard,
				wifiVersionSoft: value.wifiVersionSoft,
				initialized: value.initialized
			}
		);
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

	/** Hands control of the device to the network, or gives it back. Nothing to do with the
	 * Razer protocol despite the JSON envelope -- "razer" is simply how the LAN API carries
	 * any encoded packet, colour frames included. The payloads decode to
	 * BB 00 01 B1 01 0A and BB 00 01 B1 00 0B: command 0xB1, enable and disable. Colour
	 * frames (0xB0) are ignored unless this has been enabled.
	 *
	 * NOT FREE TO SEND. Enabling drops a frame on the device as it re-enters stream mode -- and the
	 * dropped frame cannot be refilled, since the colour frame Render sends immediately afterwards in
	 * the same tick is itself discarded. One is unnoticeable at startup; on a repeat it reads as a
	 * black flash, which shipped twice, at every 150 frames and then every 40 seconds. Send it when
	 * control is actually being taken, never on a timer, and never as a cheap "just in case".
	 * MaintainStreamingMode is the only thing that should ever call this outside of setup. */
	SetStreamingMode(enable){
		UDPServer.send(JSON.stringify({msg:{cmd:"razer", data:{pt:enable?"uwABsQEK":"uwABsQAL"}}}));
	}

	calculateXorChecksum(packet) {
		let checksum = 0;

		for (let i = 0; i < packet.length; i++) {
		  checksum ^= packet[i];
		}

		return checksum;
	}

	// Byte 4, before the colour count, changes how the device treats the colours. We sent 0x01 for
	// years without knowing what it meant. Measured on an H70BC curtain: at 0x00 a colour fills its
	// segment cleanly, at 0x01 it bleeds into the neighbouring segment. Anything above 1 behaves
	// like 1, which rules out a bit flag.
	//
	// 0x00 is the right default. SignalRGB hands us one colour per addressable segment and expects
	// them applied as given, and on a curtain the bleed crosses a physical gap between strands that
	// does not exist in the light. Whatever the field is really called, we want the version that
	// does not smear our pixels.
	createDreamViewPacket(colors, mode = 0x00) {
		// Define the Dreamview protocol header

		const packetToCheck = [mode & 0xff, colors.length / 3].concat(colors);

		const header = [0xBB, (packetToCheck.length >> 8 & 0xff), (packetToCheck.length & 0xff), 0xB0];
		const fullPacket = header.concat(packetToCheck);
		const checksum = this.calculateXorChecksum(fullPacket);
		fullPacket.push(checksum);

		return fullPacket;
	}

	createRazerPacketV1(colors) {
		// Define the Razer protocol header
		const header = [0xBB, 0x00, 0x0E, 0xB0, 0x01, colors.length / 3];
		const fullPacket = header.concat(colors);
		fullPacket.push(0); // Checksum

		return fullPacket;
	}

	createRazerPacketV2(colors) {
		// Define the Razer protocol header
		const header = [0xBB, 0x00, 0x0E, 0xB0, 0x01, colors.length];
		const fullPacket = header.concat(colors);
		fullPacket.push(this.calculateXorChecksum(fullPacket)); // Checksum

		return fullPacket;
	}

	SendStaticColor(RGBData){
		UDPServer.send(JSON.stringify({
			msg: {
				cmd: "colorwc",
				data: {
					color: {r: RGBData[0], g: RGBData[1], b: RGBData[2]},
					colorTemInKelvin: 0
				}
			}
		}));
	}

	SetStaticColor(RGBData){
		this.SendStaticColor(RGBData);

		// colorwc changes device state rather than streaming a frame, so the render loop has
		// to throttle itself or it floods the device. Only wanted on the render path.
		device.pause(100);
	}

	SendEncodedPacket(packet){
		const command = base64.Encode(packet);

		if(!loggedFirstFrame){
			loggedFirstFrame = true;
			const layout = subdevices.length > 0 ? `${subdevices.length} subdevice(s)` : `${ledCount} LED(s)`;
			device.log(`Streaming started: ${packet.length} byte frame over ${layout}.`);
		}

		// Debug
		//device.log(`[${protocolSelect}] segments=${(packet.length - 7)/3 | 0} raw packet bytes=${packet.length}`);

		const now = Date.now();

		// Switchable because it is the main suspect for knocking the device out of stream mode: it is
		// a non-razer command arriving in the middle of the frame stream, once a second, and Shutdown
		// already has to leave stream mode before colorwc will stick. Its replies are also the only
		// liveness signal we have, so the two cannot be judged separately -- hence the setting.
		if (statusQuery && now - this.lastPacket > 1000) {
			UDPServer.send(JSON.stringify({
				msg: {
					cmd: "devStatus",
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

	SendRGB(overrideColor) {
		let packet  = [];
		// Subdevice devices are several physical pieces placed separately on the canvas, so their
		// colors are read per piece. Everything else is one run read straight from the layout.
		const RGBData = subdevices.length > 0 ? GetRGBFromSubdevices(overrideColor) : GetDeviceRGB(overrideColor);

		switch (protocolSelect === "Auto" ? autoProtocol : protocolSelect) {
			// One Dreamview frame, with the length computed. The old split into V1/V2 was really
			// a broken implementation sitting next to a correct one, not two protocol versions.
			case "Dreamview":
				packet = this.createDreamViewPacket(RGBData, ShouldBlend() ? 0x01 : 0x00);
				this.SendEncodedPacket(packet);
				break;
			case "RazerV1":
				packet = this.createRazerPacketV1(RGBData);
				this.SendEncodedPacket(packet);
				break;
			case "RazerV2":
				packet = this.createRazerPacketV2(RGBData);
				this.SendEncodedPacket(packet);
				break;
			case "Static":
				this.SetStaticColor(RGBData.slice(0, 3));
				break;
		
			default:
				this.SetStaticColor(RGBData.slice(0, 3));
				break;
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
		this.connected = false;
		this.isReconnecting = false;
		this.lastReconnectAttempt = 0;
		this.lastLoggedError = 0;
		this.lastErrorCode = null;

		this.log = (msg) => { this.isDiscoveryServer ? service.log(msg) : device.log(msg); };

		this.responseCallbackFunction = (msg) => { this.log("No Response Callback Set Callback cannot function"); msg; };
	}

	setCallbackFunction(responseCallbackFunction) {
		this.responseCallbackFunction = responseCallbackFunction;
	}

	write(packet, address, port) {
		if(!this.server) {
			this.server = udp.createSocket();
		}

		try {
			this.server.write(packet, address, port);
		} catch(e) {
			this.log(`Write error: ${e}`);
		}
	}

	send(packet) {
		if(!this.server || !this.connected) {
			if(!this.isDiscoveryServer && !this.isReconnecting) {
				this.attemptReconnect();
			}
			return;
		}

		try {
			this.server.send(packet);
		} catch(e) {
			this.log(`Send error: ${e}`);
		}
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
	}

	stop(){
		this.connected = false;

		if(this.server) {
			try {
				this.server.disconnect();
			} catch(e) {}
			try {
				this.server.close();
			} catch(e) {}
			this.server = null;
		}
	}

	reconnect(){
		this.log("Reconnecting UDP Socket...");
		this.connected = false;
		this.isReconnecting = false;
		this.lastReconnectAttempt = Date.now();
		this.stop();
		this.start();
	}

	attemptReconnect(){
		if(this.isDiscoveryServer || this.connected) {
			return;
		}

		const now = Date.now();
		if(now - this.lastReconnectAttempt < 2000) {
			return; // Rate limit reconnects to once every 2 seconds
		}

		this.lastReconnectAttempt = now;
		this.isReconnecting = true;
		this.log(`Attempting to reconnect UDP socket to ${this.ipToConnectTo}:${this.broadcastPort}...`);
		this.stop();
		this.start();
	}

	onConnection(){
		this.connected = true;
		this.isReconnecting = false;
		this.lastErrorCode = null;
		this.log('Connected to remote socket!');
		this.log("Socket information:");
		this.log(this.server.remoteAddress(), {pretty: true});

		if(this.isDiscoveryServer) {
			this.log("Sending Check to socket and waiting for device to respond...");

			const bytesWritten = this.server.send(JSON.stringify({
				msg: {
					cmd: "scan",
					data: {
						account_topic: "reserve",
					},
				}
			}));

			if(bytesWritten === -1){
				this.log('Error sending data to remote socket');
			}
		}
	}

	onListenerResponse(msg) {
		this.log('Data received from client');
		this.log(msg, {pretty: true});
	}

	onListening(){
		const address = this.server.address();
		this.log(`Server is listening at port ${address.port}`);

		// Check if the socket is bound (no error means it's bound but we'll check anyway)
		this.log(`Socket Bound: ${this.server.state === this.server.BoundState}`);
	}

	onMessage(msg){
		if(this.isDiscoveryServer) {
			this.log('Data received from client');
			this.log(msg, {pretty: true});
			discovery.forceDiscovery(msg);
			this.server.close();

			return;
		}

		// A device socket's replies used to be logged and dropped on the floor. They arrive about
		// once a second, so they are handed to the callback rather than logged -- the handler decides
		// what is worth saying.
		this.responseCallbackFunction(msg);
	}

	onError(code, message){
		const now = Date.now();
		// Throttle error logging so it doesn't flood the log 100 times per second
		if(this.lastErrorCode !== code || now - this.lastLoggedError > 3000) {
			this.log(`Error: ${code} - ${message}`);
			this.lastLoggedError = now;
			this.lastErrorCode = code;
		}

		this.connected = false;
		this.isReconnecting = false;
		sawConnectedSocket = false;

		if(this.server) {
			try {
				this.server.close();
			} catch(e) {}
			this.server = null;
		}

		if(!this.isDiscoveryServer) {
			this.attemptReconnect();
		}
	}
}

class IPCache{
	constructor(){
		this.cacheMap = new Map();
		this.persistanceId = "ipCache";
		this.persistanceKey = "cache";

		this.PopulateCacheFromStorage();
	}
	Add(key, value){
		service.log(`Adding ${key} to IP Cache...`);

		this.cacheMap.set(key, value);
		this.Persist();
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
/** @typedef { {name: string, ledCount: number, size: number[], ledNames: string[], ledPositions: number[][] } } GoveeSubdevice */
/** blendSegments: whether the device should fade between the colors we send rather than applying
 * each to its own segment. Absent means blend, matching what shipped before the byte was
 * understood. Set false on anything built from separate physical pieces -- on a curtain the fade
 * crosses the gap between two hanging strands, a seam that exists in the data order and not in
 * the light. */
// eslint-disable-next-line max-len
/** @typedef { {name: string, deviceImage: string, sku: string, state: number, supportRazer: boolean, supportDreamView: boolean, ledCount: number, hasVariableLedCount?: boolean, usesSubDevices?: boolean, subdevices?: GoveeSubdevice[], blendSegments?: boolean } } GoveeDevice */
/** @type {Object.<string, GoveeDevice>} */
const GoveeDeviceLibrary = {
	H6061: {
		name: "Glide Hexa Light Panels",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6061.png",
		sku: "H6061",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 30
	},
	H6062: {
		name: "Glide Wall Light",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6062.png",
		sku: "H6062",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 29, // This can support more? 5 * Segment Count - 1?
		hasVariableLedCount: true,
	},
	H6065: {
		name: "Glide Y Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6065.png",
		sku: "H6065",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H6066: {
		name: "Glide Hexa Pro Light Panels",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6066.png",
		sku: "H6066",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H6067: {
		name: "Glide Tri Light Panels",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6067.png",
		sku: "H6067",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H6609: {
		name: "Gaming Light Strip G1",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6609.png",
		sku: "H6609",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 20,
		size: [7, 5],
		ledNames: [
			"Led 1", "Led 2", "Led 3", "Led 4", "Led 5",
			"Led 6", "Led 7", "Led 8", "Led 9", "Led 10",
			"Led 11", "Led 12", "Led 13", "Led 14", "Led 15",
			"Led 16", "Led 17", "Led 18", "Led 19", "Led 20"
		],
		ledPositions: [
			[0, 4], [0, 3], [0, 2], [0, 1], [0, 0],
			[1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0],
			[6, 1], [6, 2], [6, 3], [6, 4],
			[5, 4], [4, 4], [3, 4], [2, 4], [1, 4]
		]
	},
	H610A: {
		name: "Glide Lively Wall Light",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h610a.png",
		sku: "H610A",
		state: 1,
		supportRazer: false,
		supportDreamView: true,
		ledCount: 24
	},
	H610B: {
		name: "Glide Music Wall Light",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h610b.png",
		sku: "H610B",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H6087: {
		name: "RGBIC Fixture Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6087.png",
		sku: "H6087",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H6056: {
		name: "Flow Plus Light Bar",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6056.png",
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
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6046.png",
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
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6047.png",
		sku: "H6047",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H6048: {
		name: "RGBIC TV Light Bars Pro",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6048.png",
		sku: "H6048",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 0,
		usesSubDevices: true,
		subdevices: [
			{
				name: "RGBIC TV Light Bars Pro",
				ledCount: 10,
				size: [1, 10],
				ledNames: ["Led 1", "Led 2", "Led 3", "Led 4", "Led 5", "Led 6", "Led 7", "Led 8", "Led 9", "Led 10"],
				ledPositions: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [0, 7], [0, 8], [0, 9]],
			},
			{
				name: "RGBIC TV Light Bars Pro",
				ledCount: 10,
				size: [1, 10],
				ledNames: ["Led 1", "Led 2", "Led 3", "Led 4", "Led 5", "Led 6", "Led 7", "Led 8", "Led 9", "Led 10"],
				ledPositions: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [0, 7], [0, 8], [0, 9]],
			},
		]
	},
	H6051: {
		name: "Table Lamp Lite",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6052.png",
		sku: "H6051",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 15
	},
	H6059: {
		name: "RGB Night Light Mini",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6059.png",
		sku: "H6059",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H6052: {
		name: "RGBICWW Table Lamp",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6052.png",
		sku: "H6052",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H61A0: {
		name: "3m RGBIC Neon Rope Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h61a0.png",
		sku: "H61A0",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H61A1: {
		name: "2m RGBIC Neon Rope Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h61a0.png",
		sku: "H61A1",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H61A2: {
		name: "5m RGBIC Neon Rope Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h61a0.png",
		sku: "H61A2",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 70
	},
	H61A3: {
		name: "4m RGBIC Neon Rope Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h61a0.png",
		sku: "H61A3",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H619A: {
		name: "5m RGBIC Pro Strip Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h619a.png",
		sku: "H619A",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 20
	},
	H619B: {
		name: "7.5m RGBIC Pro Strip Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h619a.png",
		sku: "H619B",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H619C: {
		name: "10m RGBIC Pro Strip Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h619a.png",
		sku: "H619C",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H619D: {
		name: "2*7.5m RGBIC Pro Strip Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h619a.png",
		sku: "H619D",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H619E: {
		name: "2*10m RGBIC Pro Strip Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h619a.png",
		sku: "H619E",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 30
	},
	H619Z: {
		name: "3m RGBIC Pro Strip Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h619a.png",
		sku: "H619Z",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 12
	},
	H61B2: {
		name: "3m RGBIC Neon TV Backlight",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h61b2.png",
		sku: "H61B2",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H61B5: {
		name: "3m RGBIC Neon TV Backlight",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h61b2.png",
		sku: "H61B5",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 15
	},
	H61C2: {
		name: "RGBIC LED Neon Rope Lights for Desks",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h61c2.png",
		sku: "H61C2",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 16
	},
	H61C3: {
		name: "RGBIC LED Neon Rope Lights for Desks",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h61c2.png",
		sku: "H61C3",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 42
	},
	H61C5: {
		name: "RGBIC LED Neon Rope Lights for Desks",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h61c2.png",
		sku: "H61C5",
		state: 1,
		supportDreamView: true,
		supportRazer: true,
		ledCount: 15
	},
	H61E0: {
		name: "LED Strip Light M1",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h61e0.png",
		sku: "H61E0",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 20
	},
	H61E1: {
		name: "LED Strip Light M1",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h61e0.png",
		sku: "H61E1",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H6172: {
		name: "10m Outdoor RGBIC Strip Light",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6172.png",
		sku: "H6172",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H615A: {
		name: "5m RGB Strip Light",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h615a.png",
		sku: "H615A",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H6110: {
		name: "2*5m MultiColor Strip Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6110.png",
		sku: "H6110",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H618A: {
		name: "5m RGBIC Basic Strip Light",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h618a.png",
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
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h618a.png",
		sku: "H618C",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 12
	},
	H618E: {
		name: "2*10m RGBIC Bassic Strip Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h618a.png",
		sku: "H618E",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H6117: {
		name: "2*5m RGBIC Strip Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6117.png",
		sku: "H6117",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H61A5: {
		name: "10m RGBIC Neon Rope Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h61a0.png",
		sku: "H61A5",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 30
	},
	H615B: {
		name: "10m RGB Strip Light",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h615a.png",
		sku: "H615B",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H615C: {
		name: "15m RGB Strip Light",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h615a.png",
		sku: "H615C",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H615D: {
		name: "15m RGB Strip Light",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h615a.png",
		sku: "H615D",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H618F: {
		name: "2*15m RGBIC LED Strip Light",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h618a.png",
		sku: "H618F",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H6072: {
		name: "RGBICWW Floor Lamp",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6072.png",
		sku: "H6072",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 8
	},
	H6073: {
		name: "Smart RGB Floor Lamp",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6073.png",
		sku: "H6073",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H6076: {
		name: "RGBICW Floor Lamp Basic",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6076.png",
		sku: "H6076",
		state: 1,
		supportRazer: false,
		supportDreamView: true,
		ledCount: 68
	},
	H6079: {
		name: "RGBICWW Floor Lamp Pro",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6079.png",
		sku: "H6079",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 10,
	},
	H7060: {
		name: "4 Pack RGBIC Flood Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h7060.png",
		sku: "H7060",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H7061: {
		name: "2 Pack RGBIC Flood Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h7060.png",
		sku: "H7061",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H7062: {
		name: "6 Pack RGBIC Flood Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h7060.png",
		sku: "H7062",
		state: 1,
		supportRazer: false,
		supportDreamView: false,
		ledCount: 1
	},
	H70B1: {
		name: "Curtain Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h70b1.png",
		sku: "H70B1",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 10
	},
	H70BC: {
		name: "Netflix Curtain Lights",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h70b1.png",
		sku: "H70BC",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		// 400 physical LEDs in 20 hanging strands, but DreamView only addresses the strands: one
		// colour lights one whole strand, and colour index maps to strand 1:1. Verified on
		// hardware. Sending any other count makes the device spread the colours across the strands
		// in a way that does not match what was sent, and above 20 it blanks entirely. LedFx report
		// the same ceiling independently: "H70B1 Curtain Lights: ceases to work about 20".
		ledCount: 20,
		// Separate hanging strands, so blending fades across a gap that is not there in the light.
		blendSegments: false
	},
	H61D5: {
		name: "RGBIC Neon Lights 2",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h61d5.png",
		sku: "H61D5",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 68,
		hasVariableLedCount: true
	},
	H6167: {
		name: "RGBIC TV Light Bars",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6168.png",
		sku: "H6167",
		state: 1,
		supportDreamView: true,
		supportRazer: true,
		ledCount: 10
	},
	H6168: {
		name: "RGBIC TV Light Bars",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6168.png",
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
	},
	H7075: {
		name: "Govee Outdoor Wall Light, 1500LM",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h7075.png",
		sku: "H7075",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 10
	},
	H606A: {
		name: "Hex Glide Ultra",
		deviceImage : "https://assets.signalrgb.com/devices/brands/govee/wifi/h606a.png",
		sku: "H606A",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 10, // Linked panels that goes up to 21 per controller
		hasVariableLedCount: true
	},
	H8022 : {
		name: "RGBIC Table Lamp",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h8022.png",
		sku: "H8022",
		state: 1,
		supportDreamView: true,
		supportRazer: true,
		ledCount: 15
	},
	H8072: {
		name: "RGBIC Floor Lamp",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h8072.png",
		sku: "H8072",
		state: 1,
		supportDreamView: true,
		supportRazer: true,
		ledCount: 15
	},
	H7053: {
		name: "Outdoor Ground Lights 2",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h7053.png",
		sku: "H7053",
		state: 1,
		supportRazer: false,
		supportDreamView: true,
		ledCount: 30
	},
	H61B3: {
		name: "3m RGBIC LED Strip Light with Cover",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h61b2.png",
		sku: "H61B3",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 30
	},
	H7039: {
		name: "Smart Outdoor String Lights 2",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h7039.png",
		sku: "H7039",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 45
	},
	H60A1: {
		name: "Smart Ceiling Light",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h60a1.png",
		sku: "H60A1",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 13
	},
	H702A: {
		name: "S14 Bulb Outdoor String Lights 2",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h702a.png",
		sku: "H702A",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 15
	},
	H61E6: {
		name: "COB LED Strip Light Pro",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h61e6.png",
		sku: "H61E6",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 60
	},
	H612C: {
		name: " RGBIC LED Strip Lights With Protective Coating",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h612c.png",
		sku: "H612C",
		state: 1,
		supportRazer: false,
		supportDreamView: true,
		ledCount: 20
	},
};
