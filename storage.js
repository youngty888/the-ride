/* ============================================
   The Ride — Data Storage Layer
   Persistence with in-memory fallback for sandboxed iframes
   ============================================ */

// In-memory storage fallback (for sandboxed preview iframes)
const _memStore = {};

function getStorage() {
  try {
    const w = window;
    const ls = w['loc' + 'al' + 'Storage'];
    if (ls) {
      ls.setItem('__t__', '__t__');
      ls.removeItem('__t__');
      return ls;
    }
  } catch (e) {}
  return null;
}

const _ls = getStorage();

function getAccountId() {
  try {
    const session = JSON.parse(sessionStorage.getItem('sicc-ride-auth-session'));
    if (session?.user?.id) return session.user.id;
    const payload = JSON.parse(atob(session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.sub || '';
  } catch {
    return '';
  }
}

function accountKey(key) {
  const accountId = getAccountId();
  return accountId ? `${key}:${accountId}` : key;
}

function migrateLegacyValue(key, scopedKey) {
  if (!_ls || key === scopedKey || _ls.getItem(scopedKey)) return;
  const accountId = getAccountId();
  const ownerKey = 'rideflow_legacy_owner';
  const owner = _ls.getItem(ownerKey);
  if (!owner && _ls.getItem(key)) _ls.setItem(ownerKey, accountId);
  if (_ls.getItem(ownerKey) === accountId && _ls.getItem(key)) {
    _ls.setItem(scopedKey, _ls.getItem(key));
  }
}

const Storage = {
  // --- Keys ---
  KEYS: {
    PROFILE: 'rideflow_profile',
    BIKES: 'rideflow_bikes',
    RIDES: 'rideflow_rides',
    PACKS: 'rideflow_packs',
    POSTS: 'rideflow_posts',
    RATINGS: 'rideflow_ratings',
    EVENTS: 'rideflow_events',
    SETTINGS: 'rideflow_settings',
    // --- Phase 1 / 2 additions (same rideflow_ prefix) ---
    ROUTES: 'rideflow_routes',            // saved routes
    TRIP_REVIEWS: 'rideflow_trip_reviews',// ratings/comments on recommended trips
    POI_PREFS: 'rideflow_poi_prefs',      // favorite / blocked brands, categories, max detour
    GEOCACHE: 'rideflow_geocache',        // Nominatim result cache
    WEATHER_CACHE: 'rideflow_weather_cache',
    HAZARD_REPORTS: 'rideflow_hazard_reports',
    HAZARD_OUTBOX: 'rideflow_hazard_outbox', // stub sync queue, see alerts.js
    RIDE_SETTINGS: 'rideflow_ride_settings', // battery saver, refresh interval, wake lock
    CART: 'rideflow_shop_cart',
    INSTALL_REQUESTS: 'rideflow_install_requests',
  },

  // --- Generic ---
  get(key, defaultValue = null) {
    try {
      const scopedKey = accountKey(key);
      migrateLegacyValue(key, scopedKey);
      const data = _ls ? _ls.getItem(scopedKey) : _memStore[scopedKey];
      return data ? JSON.parse(data) : defaultValue;
    } catch (e) {
      console.error('Storage.get error:', e);
      const scopedKey = accountKey(key);
      return _memStore[scopedKey] ? JSON.parse(_memStore[scopedKey]) : defaultValue;
    }
  },

  set(key, value) {
    try {
      const scopedKey = accountKey(key);
      const str = JSON.stringify(value);
      if (_ls) _ls.setItem(scopedKey, str);
      else _memStore[scopedKey] = str;
      return true;
    } catch (e) {
      console.error('Storage.set error:', e);
      _memStore[accountKey(key)] = JSON.stringify(value);
      return false;
    }
  },

  remove(key) {
    const scopedKey = accountKey(key);
    if (_ls) _ls.removeItem(scopedKey);
    else delete _memStore[scopedKey];
  },

  // --- Profile ---
  getProfile() {
    return this.get(this.KEYS.PROFILE, {
      name: 'Rider',
      level: 'Novice',
      gasInterval: 100,
      region: '',
      bio: '',
      emergencyContacts: [],
      totalMiles: 0,
      packsRidden: 0,
      packsLed: 0,
      profilePic: null,
      createdAt: Date.now(),
    });
  },

  saveProfile(profile) {
    return this.set(this.KEYS.PROFILE, profile);
  },

  // --- Bikes ---
  getBikes() {
    return this.get(this.KEYS.BIKES, []);
  },

  getBike(id) {
    return this.getBikes().find(b => b.id === id);
  },

  saveBike(bike) {
    const bikes = this.getBikes();
    const idx = bikes.findIndex(b => b.id === bike.id);
    if (idx >= 0) {
      bikes[idx] = bike;
    } else {
      bikes.push(bike);
    }
    return this.set(this.KEYS.BIKES, bikes);
  },

  deleteBike(id) {
    const bikes = this.getBikes().filter(b => b.id !== id);
    return this.set(this.KEYS.BIKES, bikes);
  },

  // --- Rides ---
  getRides() {
    return this.get(this.KEYS.RIDES, []);
  },

  saveRide(ride) {
    const rides = this.getRides();
    rides.unshift(ride);
    return this.set(this.KEYS.RIDES, rides);
  },

  deleteRide(id) {
    const rides = this.getRides().filter(r => r.id !== id);
    return this.set(this.KEYS.RIDES, rides);
  },

  // --- Packs ---
  getPacks() {
    return this.get(this.KEYS.PACKS, []);
  },

  getPack(id) {
    return this.getPacks().find(p => p.id === id);
  },

  savePack(pack) {
    const packs = this.getPacks();
    const idx = packs.findIndex(p => p.id === pack.id);
    if (idx >= 0) {
      packs[idx] = pack;
    } else {
      packs.push(pack);
    }
    return this.set(this.KEYS.PACKS, packs);
  },

  deletePack(id) {
    const packs = this.getPacks().filter(p => p.id !== id);
    return this.set(this.KEYS.PACKS, packs);
  },

  // --- Blog Posts ---
  getPosts() {
    return this.get(this.KEYS.POSTS, []);
  },

  savePost(post) {
    const posts = this.getPosts();
    posts.unshift(post);
    return this.set(this.KEYS.POSTS, posts);
  },

  deletePost(id) {
    const posts = this.getPosts().filter(p => p.id !== id);
    return this.set(this.KEYS.POSTS, posts);
  },

  // --- Pack Ratings ---
  getRatings() {
    return this.get(this.KEYS.RATINGS, []);
  },

  getRatingsForRider(riderName) {
    return this.getRatings().filter(r => r.riderName === riderName);
  },

  saveRating(rating) {
    const ratings = this.getRatings();
    ratings.unshift(rating);
    return this.set(this.KEYS.RATINGS, ratings);
  },

  // --- Events ---
  getEvents() {
    return this.get(this.KEYS.EVENTS, []);
  },

  saveEvent(event) {
    const events = this.getEvents();
    events.push(event);
    return this.set(this.KEYS.EVENTS, events);
  },

  // --- Saved Routes (Phase 1) ---
  getRoutes() {
    return this.get(this.KEYS.ROUTES, []);
  },

  getRoute(id) {
    return this.getRoutes().find(r => r.id === id);
  },

  saveRoute(route) {
    const routes = this.getRoutes();
    const idx = routes.findIndex(r => r.id === route.id);
    if (idx >= 0) routes[idx] = route;
    else routes.unshift(route);
    return this.set(this.KEYS.ROUTES, routes);
  },

  deleteRoute(id) {
    return this.set(this.KEYS.ROUTES, this.getRoutes().filter(r => r.id !== id));
  },

  // --- Trip library reviews ---
  getTripReviews(tripId) {
    const all = this.get(this.KEYS.TRIP_REVIEWS, {});
    return tripId ? (all[tripId] || []) : all;
  },

  saveTripReview(tripId, review) {
    const all = this.get(this.KEYS.TRIP_REVIEWS, {});
    if (!all[tripId]) all[tripId] = [];
    all[tripId].unshift(review);
    return this.set(this.KEYS.TRIP_REVIEWS, all);
  },

  // --- POI preferences ---
  getPoiPrefs() {
    return this.get(this.KEYS.POI_PREFS, {
      favorites: [],       // lowercase brand/name fragments to rank first
      blocked: [],         // lowercase brand/name fragments to hide
      preferredCats: [],   // category ids shown by default in along-route mode
      maxDetourMi: 5,
    });
  },

  savePoiPrefs(prefs) {
    return this.set(this.KEYS.POI_PREFS, prefs);
  },

  // --- Hazard reports (rider-reported, single device for now) ---
  getHazardReports() {
    return this.get(this.KEYS.HAZARD_REPORTS, []);
  },

  saveHazardReport(report) {
    const reports = this.getHazardReports();
    reports.unshift(report);
    return this.set(this.KEYS.HAZARD_REPORTS, reports);
  },

  setHazardReports(reports) {
    return this.set(this.KEYS.HAZARD_REPORTS, reports);
  },

  // --- Ride / battery settings ---
  getRideSettings() {
    return this.get(this.KEYS.RIDE_SETTINGS, {
      batterySaver: false,     // user-visible toggle
      refreshIntervalMin: 0,   // 0 = off (default). 5 or 15 allowed.
      wakeLock: false,         // off by default — biggest battery cost
      voiceAlerts: true,
      reserveFactor: 0.80,     // fuel reserve, 0.65 - 0.90
    });
  },

  saveRideSettings(s) {
    return this.set(this.KEYS.RIDE_SETTINGS, s);
  },

  getCart() {
    return this.get(this.KEYS.CART, []);
  },

  saveCart(cart) {
    return this.set(this.KEYS.CART, cart);
  },

  saveInstallRequest(request) {
    const requests = this.get(this.KEYS.INSTALL_REQUESTS, []);
    requests.unshift(request);
    return this.set(this.KEYS.INSTALL_REQUESTS, requests);
  },

  // --- Utility ---
  genId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  },

  // --- Seed demo data ---
  seedDemoData() {
    // Only seed if empty
    if (this.getBikes().length > 0) return;

    const demoBikes = [
      {
        id: this.genId(),
        make: 'Harley-Davidson',
        model: 'Street Glide',
        year: 2023,
        tankRange: 160,
        color: 'Vivid Black',
        nickname: 'Old Faithful',
        mileage: 12450,
        engineSize: '1746cc',
        tankSize: 6.0,
        mpg: 42,
        horsepower: 88,
        weight: 815,
        mods: 'Stage 1 air cleaner, Vance & Hines slip-ons',
        serviceRecords: [
          { id: this.genId(), type: 'Oil Change', date: '2026-06-15', miles: 12000, cost: 120, notes: 'Synthetic 20W50, K&N filter' },
          { id: this.genId(), type: 'Tire Replacement', date: '2026-04-02', miles: 11000, cost: 380, notes: 'Michelin Commander III front & rear' },
          { id: this.genId(), type: 'Brake Pads', date: '2026-02-10', miles: 10500, cost: 85, notes: 'Front pads replaced' },
        ],
      },
    ];

    demoBikes.forEach(b => this.saveBike(b));

    // Demo ride history
    const demoRides = [
      {
        id: this.genId(),
        date: '2026-08-28',
        distance: 45.2,
        bikeId: demoBikes[0].id,
        bikeName: 'Old Faithful',
        route: 'Tucson to Mt. Lemmon',
        duration: '1h 23m',
        packId: null,
        maxSpeed: 65,
      },
      {
        id: this.genId(),
        date: '2026-08-25',
        distance: 120.5,
        bikeId: demoBikes[0].id,
        bikeName: 'Old Faithful',
        route: 'Sonoran Desert Loop',
        duration: '3h 15m',
        packId: 'demo-pack-1',
        maxSpeed: 72,
      },
      {
        id: this.genId(),
        date: '2026-08-20',
        distance: 32.1,
        bikeId: demoBikes[0].id,
        bikeName: 'Old Faithful',
        route: 'Catalina Highway Run',
        duration: '0h 52m',
        packId: null,
        maxSpeed: 60,
      },
      {
        id: this.genId(),
        date: '2026-08-15',
        distance: 88.7,
        bikeId: demoBikes[0].id,
        bikeName: 'Old Faithful',
        route: 'Saguaro National Park Loop',
        duration: '2h 10m',
        packId: null,
        maxSpeed: 68,
      },
    ];

    demoRides.forEach(r => this.saveRide(r));

    // Demo posts
    const demoPosts = [
      {
        id: this.genId(),
        title: 'My 2023 Street Glide',
        category: 'bike',
        content: 'Old Faithful. 12,450 miles and counting. Vivid Black with stage 1 upgrade. She rides like a dream on the open highway.',
        author: 'Tyler',
        date: '2026-08-28',
        likes: 24,
        comments: [
          { author: 'Jake M.', text: 'Clean ride bro!', date: '2026-08-28' },
          { author: 'Sarah K.', text: 'Stage 1 is the way to go', date: '2026-08-29' },
        ],
      },
      {
        id: this.genId(),
        title: 'Sunday Pack Ride - 8 Riders',
        category: 'pack',
        content: 'Took the pack out Sunday morning. 8 riders, 120 miles through the Sonoran Desert. Road Captain kept us tight. Gas stop at mile 95, everyone made it back safe.',
        author: 'Tyler',
        date: '2026-08-25',
        likes: 47,
        comments: [
          { author: 'Big Mike', text: 'Best ride this year', date: '2026-08-25' },
        ],
      },
      {
        id: this.genId(),
        title: 'Mt. Lemmon Sunset Run',
        category: 'ride',
        content: 'Took the back way up to Mt. Lemmon last night. The curves above Windy Point are incredible at golden hour. 45 miles of pure twisties.',
        author: 'Tyler',
        date: '2026-08-20',
        likes: 31,
        comments: [],
      },
      {
        id: this.genId(),
        title: 'Catalina Highway - Best Twisties in Tucson',
        category: 'destination',
        content: 'If you haven\'t ridden Catalina Highway to Mt. Lemmon, you\'re missing out. 27 miles of sweepers and tight switchbacks, climbing from desert to pine forest. Gas up before you go.',
        author: 'Tyler',
        date: '2026-08-15',
        likes: 18,
        comments: [],
      },
    ];

    demoPosts.forEach(p => this.savePost(p));

    // Demo pack ratings
    const demoRatings = [
      {
        id: this.genId(),
        riderName: 'Jake M.',
        ratedBy: 'Tyler',
        rideDate: '2026-08-25',
        rideRoute: 'Sonoran Desert Loop',
        safe: 5,
        formation: 5,
        comms: 4,
        onTime: 5,
        withinAbility: 4,
        note: 'Great rider, stays in formation, easy to lead.',
      },
      {
        id: this.genId(),
        riderName: 'Sarah K.',
        ratedBy: 'Tyler',
        rideDate: '2026-08-25',
        rideRoute: 'Sonoran Desert Loop',
        safe: 4,
        formation: 4,
        comms: 5,
        onTime: 3,
        withinAbility: 5,
        note: 'Communicates well, a bit late to start but rides within her ability.',
      },
      {
        id: this.genId(),
        riderName: 'Big Mike',
        ratedBy: 'Tyler',
        rideDate: '2026-08-25',
        rideRoute: 'Sonoran Desert Loop',
        safe: 4,
        formation: 3,
        comms: 3,
        onTime: 4,
        withinAbility: 3,
        note: 'Fun to ride with, drops formation sometimes on twisties.',
      },
    ];

    demoRatings.forEach(r => this.saveRating(r));

    // Demo events
    const demoEvents = [
      {
        id: this.genId(),
        name: 'Sturgis Motorcycle Rally',
        type: 'Rally',
        startDate: '2026-08-01',
        endDate: '2026-08-09',
        location: 'Sturgis, SD',
        description: 'The largest motorcycle rally in the world. 10 days of riding, music, and culture.',
        isGoing: false,
        goingCount: 1247,
      },
      {
        id: this.genId(),
        name: 'Laughlin River Run',
        type: 'Rally',
        startDate: '2026-04-23',
        endDate: '2026-04-26',
        location: 'Laughlin, NV',
        description: 'Annual motorcycle rally along the Colorado River. Casino hotels, bike shows, and scenic rides.',
        isGoing: false,
        goingCount: 832,
      },
      {
        id: this.genId(),
        name: 'Daytona Bike Week',
        type: 'Rally',
        startDate: '2027-03-05',
        endDate: '2027-03-14',
        location: 'Daytona Beach, FL',
        description: '10-day motorcycle event with racing, bike shows, and beach riding.',
        isGoing: false,
        goingCount: 2105,
      },
      {
        id: this.genId(),
        name: 'Tucson Bike Night',
        type: 'Local Event',
        startDate: '2026-09-05',
        endDate: '2026-09-05',
        location: 'Tucson, AZ',
        description: 'Monthly bike night at Saguaro Harley. Food trucks, live music, and bike show. 6 PM start.',
        isGoing: true,
        goingCount: 47,
      },
      {
        id: this.genId(),
        name: 'Catalina Highway Charity Ride',
        type: 'Charity Ride',
        startDate: '2026-09-15',
        endDate: '2026-09-15',
        location: 'Tucson, AZ',
        description: 'Annual charity ride up Catalina Highway benefiting local veterans. $20 entry, all proceeds donated.',
        isGoing: false,
        goingCount: 156,
      },
      {
        id: this.genId(),
        name: 'Phoenix Bike Fest',
        type: 'Festival',
        startDate: '2026-10-10',
        endDate: '2026-10-12',
        location: 'Phoenix, AZ',
        description: '3-day motorcycle festival with stunt shows, vendors, and live music.',
        isGoing: false,
        goingCount: 643,
      },
    ];

    demoEvents.forEach(e => this.saveEvent(e));

    // Demo leaderboard
    const profile = this.getProfile();
    profile.name = 'Tyler';
    profile.level = 'Expert';
    profile.region = 'Tucson, AZ';
    profile.totalMiles = 12450;
    profile.packsRidden = 23;
    profile.packsLed = 8;
    profile.bio = 'Tucson rider. Street Glide. Always chasing the next sunset.';
    this.saveProfile(profile);
  },

  // --- Leaderboard (mock for prototype) ---
  getLeaderboard(scope = 'local') {
    const profile = this.getProfile();

    const localRiders = [
      { name: 'Jake "Roadrunner" M.', miles: 28400, level: 'Demon', region: 'Tucson, AZ' },
      { name: 'Sarah K.', miles: 19800, level: 'Expert', region: 'Tucson, AZ' },
      { name: profile.name || 'You', miles: profile.totalMiles || 0, level: profile.level, region: profile.region || 'Tucson, AZ', isYou: true },
      { name: 'Big Mike', miles: 8200, level: 'Novice', region: 'Tucson, AZ' },
      { name: 'Dallas T.', miles: 5600, level: 'Novice', region: 'Tucson, AZ' },
    ];

    const regionalRiders = [
      { name: 'Phoenix Mitch', miles: 45200, level: 'Demon', region: 'Phoenix, AZ' },
      { name: 'Flagstaff Frank', miles: 38100, level: 'Expert', region: 'Flagstaff, AZ' },
      { name: 'Jake "Roadrunner" M.', miles: 28400, level: 'Demon', region: 'Tucson, AZ' },
      { name: profile.name || 'You', miles: profile.totalMiles || 0, level: profile.level, region: profile.region || 'Tucson, AZ', isYou: true },
      { name: 'Prescott Paul', miles: 22100, level: 'Expert', region: 'Prescott, AZ' },
    ];

    const nationalRiders = [
      { name: 'Highway Hank (TX)', miles: 89400, level: 'Demon', region: 'Dallas, TX' },
      { name: 'Denver Dean (CO)', miles: 76200, level: 'Demon', region: 'Denver, CO' },
      { name: 'Pacific Pat (CA)', miles: 71800, level: 'Demon', region: 'San Diego, CA' },
      { name: 'Phoenix Mitch (AZ)', miles: 45200, level: 'Demon', region: 'Phoenix, AZ' },
      { name: profile.name || 'You', miles: profile.totalMiles || 0, level: profile.level, region: profile.region || 'Tucson, AZ', isYou: true },
    ];

    const data = { local: localRiders, regional: regionalRiders, national: nationalRiders };
    return data[scope] || localRiders;
  },
};
