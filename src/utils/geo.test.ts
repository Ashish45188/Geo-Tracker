import {
  shouldRecordLocationUpdate,
  calculateCumulativeDistance,
  filterRoutePoints,
  MAX_POOR_ACCURACY_METERS,
} from './geo';

function runTests() {
  console.log('=== STARTING GPS GEOLOCATION & ROUTE FILTERING TESTS ===\n');
  let passed = 0;
  let total = 0;

  function assert(condition: boolean, message: string) {
    total++;
    if (condition) {
      console.log(`[PASS] Test ${total}: ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] Test ${total}: ${message}`);
      throw new Error(`Test failed: ${message}`);
    }
  }

  // Test 1: Ignore updates with poor accuracy (> 100m)
  {
    const res = shouldRecordLocationUpdate(null, {
      latitude: 19.0760,
      longitude: 72.8777,
      accuracy: 120, // > 100m
      timestamp: Date.now(),
    });
    assert(!res.shouldRecord, 'Rejects initial update with poor accuracy (> 100m)');
  }

  // Test 2: Accept initial update with valid accuracy (e.g., ±88m)
  const initialPoint = {
    latitude: 19.0760,
    longitude: 72.8777,
    accuracy: 88,
    timestamp: 1000000,
  };
  {
    const res = shouldRecordLocationUpdate(null, initialPoint);
    assert(res.shouldRecord, 'Accepts initial update with valid accuracy (±88m <= 100m)');
  }

  // Test 3: Ignore stationary GPS drift / jitter (30m movement with ±88m accuracy)
  {
    const jitterPoint = {
      latitude: 19.0762,
      longitude: 72.8779,
      accuracy: 88,
      timestamp: 1005000, // 5 seconds later
    };
    const res = shouldRecordLocationUpdate(initialPoint, jitterPoint);
    assert(!res.shouldRecord, 'Ignores stationary GPS drift (30m < 105.6m threshold for ±88m accuracy)');
  }

  // Test 4: Time elapsed alone does NOT trigger movement recording
  {
    const stationaryPointAfter1Minute = {
      latitude: 19.07605,
      longitude: 72.87775,
      accuracy: 88,
      timestamp: 1060000, // 60 seconds later, almost same location
    };
    const res = shouldRecordLocationUpdate(initialPoint, stationaryPointAfter1Minute);
    assert(!res.shouldRecord, 'Time elapsed alone does not create route movement points when stationary');
  }

  // Test 5: Accept genuine physical travel (e.g. 200m movement with ±80m accuracy)
  const movedPoint = {
    latitude: 19.0778,
    longitude: 72.8777,
    accuracy: 80,
    timestamp: 1030000, // 30 seconds later
  };
  {
    const res = shouldRecordLocationUpdate(initialPoint, movedPoint);
    assert(res.shouldRecord, 'Accepts genuine physical travel (200m >= threshold 100.8m)');
  }

  // Test 6: Reject unrealistic speed jumps (e.g., 5 km in 2 seconds)
  {
    const teleportPoint = {
      latitude: 19.1200,
      longitude: 72.8777,
      accuracy: 15,
      timestamp: 1002000, // 2 seconds later
    };
    const res = shouldRecordLocationUpdate(initialPoint, teleportPoint);
    assert(!res.shouldRecord, 'Rejects unrealistic speed jump (5 km in 2s)');
  }

  // Test 7: filterRoutePoints removes poor accuracy & jitter points from raw array
  {
    const rawPoints = [
      { latitude: 19.0760, longitude: 72.8777, accuracy: 88, timestamp: 1000000 },
      { latitude: 19.0762, longitude: 72.8779, accuracy: 88, timestamp: 1005000 }, // Jitter
      { latitude: 19.0761, longitude: 72.8778, accuracy: 150, timestamp: 1010000 }, // Poor acc
      { latitude: 19.07605, longitude: 72.87775, accuracy: 88, timestamp: 1015000 }, // Jitter
    ];

    const filtered = filterRoutePoints(rawPoints);
    assert(filtered.length === 1, `filterRoutePoints collapses stationary jitter array to 1 point (got ${filtered.length})`);
  }

  // Test 8: calculateCumulativeDistance returns 0 meters for stationary user with jitter
  {
    const jitterPoints = [
      { latitude: 19.0760, longitude: 72.8777, accuracy: 88, timestamp: 1000000 },
      { latitude: 19.0762, longitude: 72.8779, accuracy: 88, timestamp: 1005000 },
      { latitude: 19.0761, longitude: 72.8778, accuracy: 88, timestamp: 1010000 },
      { latitude: 19.0760, longitude: 72.8777, accuracy: 88, timestamp: 1015000 },
    ];

    const dist = calculateCumulativeDistance(jitterPoints);
    assert(dist === 0, `calculateCumulativeDistance returns 0m for stationary jitter (got ${dist}m)`);
  }

  // Test 9: calculateCumulativeDistance accurately measures real travel
  {
    const realTravelPoints = [
      { latitude: 19.0760, longitude: 72.8777, accuracy: 15, timestamp: 1000000 },
      { latitude: 19.0780, longitude: 72.8777, accuracy: 15, timestamp: 1030000 }, // ~222m north
      { latitude: 19.0800, longitude: 72.8777, accuracy: 15, timestamp: 1060000 }, // ~222m further north
    ];

    const dist = calculateCumulativeDistance(realTravelPoints);
    assert(dist > 400 && dist < 480, `calculateCumulativeDistance accurately measures ~444m travel (got ${Math.round(dist)}m)`);
  }

  console.log(`\n=== TEST RESULTS: ALL ${passed}/${total} TESTS PASSED SUCCESSFULLY! ===`);
}

runTests();
