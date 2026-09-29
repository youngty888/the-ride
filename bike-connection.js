/* Motorcycle / display connection gate for automatic mileage tracking.
   Browser Bluetooth can connect only to Bluetooth Low Energy GATT devices and
   requires a rider tap. A native motorcycle display wrapper can report its real
   connection through setNativeConnection or the ride-bike-connection event. */
const BikeConnection = {
  device: null,
  connected: false,
  name: '',
  bikeId: null,
  source: '',

  init() {
    window.addEventListener('ride-bike-connection', (event) => {
      const d = event.detail || {};
      this.setNativeConnection(!!d.connected, d);
    });
    this.renderBadge();
    this.reconnectKnown();
  },

  settings() { return Storage.getRideSettings(); },

  selectedBikeId() {
    const saved = this.settings().connectedBikeId;
    if (saved && Storage.getBike(saved)) return saved;
    const selected = document.getElementById('planBike')?.value;
    if (selected && Storage.getBike(selected)) return selected;
    return Storage.getBikes()[0]?.id || null;
  },

  async connect() {
    if (!navigator.bluetooth?.requestDevice) {
      App.toast('This browser cannot connect to motorcycle Bluetooth. Android Chrome or the native RIDE screen app is required.');
      return false;
    }
    try {
      // The rider explicitly chooses the motorcycle or display. We cannot filter
      // until its advertised BLE service UUID is known.
      const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true });
      if (!device.gatt) throw new Error('That device does not expose a Bluetooth Low Energy data connection.');
      this.device = device;
      device.addEventListener('gattserverdisconnected', () => this.setConnected(false, { source: 'bluetooth' }));
      await device.gatt.connect();
      const s = this.settings();
      s.bluetoothDeviceId = device.id;
      s.bluetoothDeviceName = device.name || 'Motorcycle Bluetooth';
      s.connectedBikeId = document.getElementById('setConnectedBike')?.value || this.selectedBikeId();
      Storage.saveRideSettings(s);
      this.setConnected(true, { name: s.bluetoothDeviceName, bikeId: s.connectedBikeId, source: 'bluetooth' });
      return true;
    } catch (error) {
      if (error?.name !== 'NotFoundError') App.toast(error?.message || 'Motorcycle Bluetooth did not connect.');
      return false;
    }
  },

  async reconnectKnown() {
    const s = this.settings();
    if (!s.bluetoothDeviceId || !navigator.bluetooth?.getDevices) return false;
    try {
      const devices = await navigator.bluetooth.getDevices();
      const device = devices.find(d => d.id === s.bluetoothDeviceId);
      if (!device?.gatt) return false;
      this.device = device;
      device.addEventListener('gattserverdisconnected', () => this.setConnected(false, { source: 'bluetooth' }));
      await device.gatt.connect();
      this.setConnected(true, { name: device.name || s.bluetoothDeviceName, bikeId: s.connectedBikeId, source: 'bluetooth' });
      return true;
    } catch (_) { return false; }
  },

  disconnect() {
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    else this.setConnected(false, { source: this.source || 'bluetooth' });
  },

  setNativeConnection(connected, detail = {}) {
    this.setConnected(connected, {
      name: detail.name || 'RIDE motorcycle screen',
      bikeId: detail.bikeId || this.selectedBikeId(),
      source: 'screen',
    });
  },

  setConnected(connected, detail = {}) {
    if (this.connected === connected && (!connected || this.bikeId === detail.bikeId)) return;
    this.connected = connected;
    if (connected) {
      this.name = detail.name || 'Motorcycle Bluetooth';
      this.bikeId = detail.bikeId || this.selectedBikeId();
      this.source = detail.source || 'bluetooth';
    }
    this.renderBadge();
    if (typeof AlertsModule !== 'undefined' && document.getElementById('settingsBody')?.offsetParent) AlertsModule.renderSettings();
    if (typeof App !== 'undefined' && App.onBikeConnectionChanged) {
      App.onBikeConnectionChanged(connected, { bikeId: this.bikeId, name: this.name, source: this.source });
    }
    if (!connected) {
      this.name = '';
      this.bikeId = null;
      this.source = '';
    }
  },

  renderBadge() {
    const badge = document.getElementById('bikeConnectionBadge');
    if (!badge) return;
    badge.hidden = !this.connected;
    badge.textContent = this.connected ? `BIKE CONNECTED · ${this.name}` : '';
  },

  settingsHtml() {
    const bikes = Storage.getBikes();
    const supported = !!navigator.bluetooth?.requestDevice;
    return `
      <h3 class="plan-section-title">Motorcycle connection</h3>
      <div class="setting-block">
        <div class="setting-label">${this.connected ? `Connected: ${App.escapeHtml(this.name)}` : 'Connect motorcycle or RIDE screen'}</div>
        <div class="setting-desc">When connected, RIDE starts mileage automatically and adds each real GPS movement to the selected motorcycle. Parked GPS wobble is ignored.</div>
        <label class="setting-text" for="setConnectedBike"><span class="setting-desc">Motorcycle receiving the mileage</span></label>
        <select id="setConnectedBike" ${bikes.length ? '' : 'disabled'}>
          ${bikes.length ? bikes.map(b => `<option value="${b.id}" ${b.id === (this.bikeId || this.selectedBikeId()) ? 'selected' : ''}>${App.escapeHtml(b.nickname || `${b.make} ${b.model}`)}</option>`).join('') : '<option value="">Add a motorcycle in Garage first</option>'}
        </select>
        <button type="button" class="btn-secondary btn-large" id="btnBikeConnection" ${bikes.length ? '' : 'disabled'}>${this.connected ? 'Disconnect motorcycle' : 'Connect motorcycle / screen'}</button>
        <div class="setting-desc">${supported ? 'Browser connection requires a rider tap and a Bluetooth Low Energy device.' : 'Bluetooth connection is unavailable in this browser. Safari on iPhone requires the native RIDE app.'}</div>
      </div>`;
  },

  bindSettings() {
    document.getElementById('setConnectedBike')?.addEventListener('change', (event) => {
      const s = this.settings(); s.connectedBikeId = event.target.value; Storage.saveRideSettings(s);
      this.bikeId = event.target.value || this.bikeId;
    });
    document.getElementById('btnBikeConnection')?.addEventListener('click', () => {
      if (this.connected) this.disconnect(); else this.connect();
    });
  },
};

// Native Android/iOS display shells can call this after the operating system has
// verified the motorcycle connection. It intentionally does not pretend a web
// page can inspect an arbitrary Classic Bluetooth audio pairing.
window.RIDEBikeConnection = {
  setConnected: (connected, detail = {}) => BikeConnection.setNativeConnection(connected, detail),
};
