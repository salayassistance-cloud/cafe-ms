import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

// Simulate canonical active-line filtering (as in KitchenDisplay and orderService)
function activeLinesForStation(items, station) {
  const type = station === 'KITCHEN' ? 'FOOD' : station === 'BARISTA' ? 'DRINK' : null;
  if (!type) return [];
  return (items || []).filter(it => it.type === type && !it.cancelled);
}
function hasActiveStationLines(order, view) {
  return (order.items || []).some(it => it.type === view && !it.cancelled);
}
function stationStatusOf(order, view) {
  return view === 'DRINK' ? (order.baristaStatus || order.status) : (order.kitchenStatus || order.status);
}
function visibleFor(order, view) {
  return (order.items || []).some(it => it.type === view && !it.cancelled);
}
function destMatchServerSide(order, dest) {
  // New server $elemMatch logic: type == dest && cancelled != true on SAME element
  if (!dest || dest === 'ALL') return true;
  return (order.items || []).some(it => it.type === dest && !it.cancelled);
}
function oldDestMatch(order, dest) {
  // Old bug: query["items.type"] = dest  (matches even if only cancelled line)
  if (!dest || dest === 'ALL') return true;
  return (order.items || []).some(it => it.type === dest);
}
// Optimistic helper mirrors new KitchenDisplay logic
function optimisticUpdate(order, view, status) {
  const next = { ...order };
  if (view === 'DRINK') next.baristaStatus = status;
  else next.kitchenStatus = status;
  const hasActiveFood = (order.items||[]).some(it=>it.type==='FOOD'&&!it.cancelled);
  const hasActiveDrink = (order.items||[]).some(it=>it.type==='DRINK'&&!it.cancelled);
  if (hasActiveFood && hasActiveDrink) {
    if (status==='PENDING') next.status='PENDING';
    else if (status==='PREPARING') next.status='PREPARING';
    else if (status==='READY') {
      const otherReady = view==='DRINK' ? order.kitchenStatus==='READY' : order.baristaStatus==='READY';
      next.status = otherReady ? 'READY' : 'PREPARING';
    }
  } else {
    next.status = status;
  }
  return next;
}
// Server updateOrderStatus simulation for station isolation
function canKitchenUpdate(order, isKitchen, isBarista) {
  const hasFood = (order.items||[]).some(i=>i.type==='FOOD'&&!i.cancelled);
  const hasDrink = (order.items||[]).some(i=>i.type==='DRINK'&&!i.cancelled);
  if (isKitchen && !hasFood) return { ok:false, err:'no active FOOD' };
  if (isBarista && !hasDrink) return { ok:false, err:'no active DRINK' };
  return { ok:true };
}

describe('KDS-SEPARATION-1 - Station Isolation', () => {
  test('A. FOOD-only order - Kitchen sees, Barista does not, actions isolated', () => {
    const foodOnly = {
      _id:'1', status:'PENDING', kitchenStatus:'PENDING', baristaStatus:null,
      items:[
        { lineId:'l1', type:'FOOD', name:'Burger', quantity:1, cancelled:false },
        { lineId:'l2', type:'FOOD', name:'Pasta', quantity:1, cancelled:false }
      ]
    };
    assert.equal(visibleFor(foodOnly,'FOOD'), true);
    assert.equal(visibleFor(foodOnly,'DRINK'), false);
    assert.equal(destMatchServerSide(foodOnly,'FOOD'), true);
    assert.equal(destMatchServerSide(foodOnly,'DRINK'), false);
    // Old dest would also not match DRINK, so not a bug for FOOD-only, but ensure new logic also correct
    assert.equal(activeLinesForStation(foodOnly.items,'KITCHEN').length,2);
    assert.equal(activeLinesForStation(foodOnly.items,'BARISTA').length,0);
    assert.equal(hasActiveStationLines(foodOnly,'FOOD'), true);
    assert.equal(hasActiveStationLines(foodOnly,'DRINK'), false);
    assert.equal(stationStatusOf(foodOnly,'FOOD'),'PENDING');
    // Kitchen Start Prep should only touch kitchenStatus
    const afterKitchenPrep = optimisticUpdate(foodOnly,'FOOD','PREPARING');
    assert.equal(afterKitchenPrep.kitchenStatus,'PREPARING');
    assert.equal(afterKitchenPrep.baristaStatus,null);
    assert.equal(afterKitchenPrep.status,'PREPARING'); // single station -> overall = station
    // Barista should be blocked server-side if tries to update FOOD-only
    const baristaAttempt = canKitchenUpdate(foodOnly,false,true);
    assert.equal(baristaAttempt.ok,false);
  });

  test('B. DRINK-only order - Barista sees, Kitchen does not', () => {
    const drinkOnly = {
      _id:'2', status:'PENDING', kitchenStatus:null, baristaStatus:'PENDING',
      items:[
        { lineId:'l3', type:'DRINK', name:'Coffee', quantity:1, cancelled:false },
        { lineId:'l4', type:'DRINK', name:'Juice', quantity:1, cancelled:false }
      ]
    };
    assert.equal(visibleFor(drinkOnly,'DRINK'), true);
    assert.equal(visibleFor(drinkOnly,'FOOD'), false);
    assert.equal(destMatchServerSide(drinkOnly,'DRINK'), true);
    assert.equal(destMatchServerSide(drinkOnly,'FOOD'), false);
    assert.equal(activeLinesForStation(drinkOnly.items,'BARISTA').length,2);
    assert.equal(activeLinesForStation(drinkOnly.items,'KITCHEN').length,0);
    assert.equal(hasActiveStationLines(drinkOnly,'DRINK'), true);
    assert.equal(hasActiveStationLines(drinkOnly,'FOOD'), false);
    const afterBaristaPrep = optimisticUpdate(drinkOnly,'DRINK','PREPARING');
    assert.equal(afterBaristaPrep.baristaStatus,'PREPARING');
    assert.equal(afterBaristaPrep.kitchenStatus,null);
    assert.equal(canKitchenUpdate(drinkOnly,true,false).ok,false);
  });

  test('C. MIXED order - both stations see only own items, actions independent', () => {
    const mixed = {
      _id:'3', status:'PENDING', kitchenStatus:'PENDING', baristaStatus:'PENDING',
      items:[
        { lineId:'l5', type:'FOOD', name:'Burger', quantity:1, cancelled:false },
        { lineId:'l6', type:'FOOD', name:'Pasta', quantity:1, cancelled:false },
        { lineId:'l7', type:'DRINK', name:'Coffee', quantity:1, cancelled:false },
        { lineId:'l8', type:'DRINK', name:'Juice', quantity:1, cancelled:false }
      ]
    };
    assert.equal(visibleFor(mixed,'FOOD'), true);
    assert.equal(visibleFor(mixed,'DRINK'), true);
    assert.equal(activeLinesForStation(mixed.items,'KITCHEN').length,2);
    assert.equal(activeLinesForStation(mixed.items,'BARISTA').length,2);
    // Kitchen sees only FOOD
    const kitchenItems = mixed.items.filter(it=>it.type==='FOOD');
    assert.equal(kitchenItems.length,2);
    assert.ok(kitchenItems.every(it=>it.type==='FOOD'));
    const baristaItems = mixed.items.filter(it=>it.type==='DRINK');
    assert.equal(baristaItems.length,2);
    assert.ok(baristaItems.every(it=>it.type==='DRINK'));
    // Kitchen Start Prep -> Barista unchanged
    const kPrep = optimisticUpdate(mixed,'FOOD','PREPARING');
    assert.equal(kPrep.kitchenStatus,'PREPARING');
    assert.equal(kPrep.baristaStatus,'PENDING');
    assert.equal(kPrep.status,'PREPARING'); // mixed PREPARING overall is PREPARING
    // Barista Start Prep -> Kitchen unchanged
    const bPrep = optimisticUpdate(mixed,'DRINK','PREPARING');
    assert.equal(bPrep.baristaStatus,'PREPARING');
    assert.equal(bPrep.kitchenStatus,'PENDING');
    // Kitchen Mark Ready -> Barista unchanged, overall NOT READY yet
    const mixedPreparing = { ...mixed, kitchenStatus:'PREPARING', baristaStatus:'PREPARING', status:'PREPARING' };
    const kReady = optimisticUpdate(mixedPreparing,'FOOD','READY');
    assert.equal(kReady.kitchenStatus,'READY');
    assert.equal(kReady.baristaStatus,'PREPARING');
    assert.equal(kReady.status,'PREPARING'); // NOT READY because Barista not ready
    // Barista Mark Ready -> Kitchen unchanged
    const bReady = optimisticUpdate(mixedPreparing,'DRINK','READY');
    assert.equal(bReady.baristaStatus,'READY');
    assert.equal(bReady.kitchenStatus,'PREPARING');
    assert.equal(bReady.status,'PREPARING');
    // Both READY -> overall READY
    const mixedOneReady = { ...mixed, kitchenStatus:'READY', baristaStatus:'PREPARING', status:'PREPARING' };
    const bReadyFinal = optimisticUpdate(mixedOneReady,'DRINK','READY');
    assert.equal(bReadyFinal.baristaStatus,'READY');
    assert.equal(bReadyFinal.kitchenStatus,'READY');
    assert.equal(bReadyFinal.status,'READY');
    const mixedOtherReady = { ...mixed, kitchenStatus:'PREPARING', baristaStatus:'READY', status:'PREPARING' };
    const kReadyFinal = optimisticUpdate(mixedOtherReady,'FOOD','READY');
    assert.equal(kReadyFinal.kitchenStatus,'READY');
    assert.equal(kReadyFinal.status,'READY');
  });

  test('D. Mixed readiness - overall READY requires both', () => {
    const kReadyBPrep = { kitchenStatus:'READY', baristaStatus:'PREPARING', status:'PREPARING' };
    // Simulate server mixedOverall: READY only if both READY
    function overall(stations, hasFood, hasDrink) {
      if (hasFood && hasDrink) {
        if (stations.kitchenStatus==='READY' && stations.baristaStatus==='READY') return 'READY';
        return 'PREPARING';
      }
      return stations.kitchenStatus || stations.baristaStatus || 'PENDING';
    }
    assert.equal(overall(kReadyBPrep,true,true),'PREPARING');
    assert.equal(overall({kitchenStatus:'PREPARING', baristaStatus:'READY'},true,true),'PREPARING');
    assert.equal(overall({kitchenStatus:'READY', baristaStatus:'READY'},true,true),'READY');
    // Single station
    assert.equal(overall({kitchenStatus:'READY', baristaStatus:null},true,false),'READY');
    assert.equal(overall({kitchenStatus:null, baristaStatus:'READY'},false,true),'READY');
  });

  test('E. Cancellation isolated - Kitchen cancels FOOD only, Barista cancels DRINK only', () => {
    const mixed = {
      items:[
        { lineId:'l9', type:'FOOD', cancelled:false },
        { lineId:'l10', type:'DRINK', cancelled:false }
      ]
    };
    // Kitchen can only cancel FOOD
    function canCancelByStation(itemType, role) {
      if (role==='KITCHEN' && itemType!=='FOOD') return false;
      if (role==='BARISTA' && itemType!=='DRINK') return false;
      return true;
    }
    assert.equal(canCancelByStation('FOOD','KITCHEN'),true);
    assert.equal(canCancelByStation('DRINK','KITCHEN'),false);
    assert.equal(canCancelByStation('DRINK','BARISTA'),true);
    assert.equal(canCancelByStation('FOOD','BARISTA'),false);
    // Filtering cancelled
    const afterFoodCancel = {
      items:[
        { lineId:'l9', type:'FOOD', cancelled:true },
        { lineId:'l10', type:'DRINK', cancelled:false }
      ],
      kitchenStatus:'PENDING', baristaStatus:'PENDING'
    };
    assert.equal(activeLinesForStation(afterFoodCancel.items,'KITCHEN').length,0);
    assert.equal(activeLinesForStation(afterFoodCancel.items,'BARISTA').length,1);
    assert.equal(hasActiveStationLines({items:afterFoodCancel.items},'FOOD'),false);
    assert.equal(hasActiveStationLines({items:afterFoodCancel.items},'DRINK'),true);
    assert.equal(destMatchServerSide({items:afterFoodCancel.items},'FOOD'),false);
    assert.equal(destMatchServerSide({items:afterFoodCancel.items},'DRINK'),true);
    // Old bug: destMatchServerSide would still match FOOD via cancelled line
    assert.equal(oldDestMatch({items:afterFoodCancel.items},'FOOD'),true); // old bug would leak
  });

  test('F. Cancelled filtering - cancelled FOOD disappears from Kitchen actions', () => {
    const order = {
      items:[
        { lineId:'l11', type:'FOOD', cancelled:true },
        { lineId:'l12', type:'FOOD', cancelled:false },
        { lineId:'l13', type:'DRINK', cancelled:true }
      ]
    };
    assert.equal(activeLinesForStation(order.items,'KITCHEN').length,1);
    assert.equal(activeLinesForStation(order.items,'BARISTA').length,0);
    assert.equal(hasActiveStationLines(order,'FOOD'),true); // one active FOOD remains
    assert.equal(hasActiveStationLines(order,'DRINK'),false);
    // Fully cancelled kitchen
    const allFoodCancelled = {
      items:[
        { lineId:'l14', type:'FOOD', cancelled:true },
        { lineId:'l15', type:'FOOD', cancelled:true }
      ]
    };
    assert.equal(hasActiveStationLines(allFoodCancelled,'FOOD'),false);
    assert.equal(destMatchServerSide(allFoodCancelled,'FOOD'),false);
    assert.equal(oldDestMatch(allFoodCancelled,'FOOD'),true); // old bug
  });

  test('G. Multiple lines remain independently actionable', () => {
    const multi = {
      items:[
        { lineId:'a1', type:'FOOD', cancelled:false },
        { lineId:'a2', type:'FOOD', cancelled:false },
        { lineId:'a3', type:'FOOD', cancelled:false },
        { lineId:'b1', type:'DRINK', cancelled:false },
        { lineId:'b2', type:'DRINK', cancelled:false }
      ]
    };
    assert.equal(activeLinesForStation(multi.items,'KITCHEN').length,3);
    assert.equal(activeLinesForStation(multi.items,'BARISTA').length,2);
    // Simulate cancelling one FOOD line
    multi.items[0].cancelled = true;
    assert.equal(activeLinesForStation(multi.items,'KITCHEN').length,2);
    assert.equal(activeLinesForStation(multi.items,'BARISTA').length,2);
    // Simulate cancelling one DRINK line
    multi.items[3].cancelled = true;
    assert.equal(activeLinesForStation(multi.items,'BARISTA').length,1);
    assert.equal(activeLinesForStation(multi.items,'KITCHEN').length,2);
  });

  test('H. Status display uses station status, not overall', () => {
    const mixed = { status:'PREPARING', kitchenStatus:'READY', baristaStatus:'PREPARING' };
    assert.equal(stationStatusOf(mixed,'FOOD'),'READY');
    assert.equal(stationStatusOf(mixed,'DRINK'),'PREPARING');
    assert.notEqual(stationStatusOf(mixed,'FOOD'), mixed.status); // Kitchen READY != overall PREPARING
    const mixed2 = { status:'PREPARING', kitchenStatus:'PREPARING', baristaStatus:'READY' };
    assert.equal(stationStatusOf(mixed2,'FOOD'),'PREPARING');
    assert.equal(stationStatusOf(mixed2,'DRINK'),'READY');
    const bothReady = { status:'READY', kitchenStatus:'READY', baristaStatus:'READY' };
    assert.equal(stationStatusOf(bothReady,'FOOD'),'READY');
    assert.equal(stationStatusOf(bothReady,'DRINK'),'READY');
    assert.equal(bothReady.status,'READY');
  });

  test('I. Station with no active lines must not receive action', () => {
    const mixedFoodCancelled = {
      status:'PENDING', kitchenStatus:null, baristaStatus:'PENDING',
      items:[
        { lineId:'c1', type:'FOOD', cancelled:true },
        { lineId:'c2', type:'DRINK', cancelled:false }
      ]
    };
    assert.equal(hasActiveStationLines(mixedFoodCancelled,'FOOD'),false);
    assert.equal(hasActiveStationLines(mixedFoodCancelled,'DRINK'),true);
    // Simulate guard: button should not render for FOOD
    const kitchenCanStart = stationStatusOf(mixedFoodCancelled,'FOOD')==='PENDING' && hasActiveStationLines(mixedFoodCancelled,'FOOD');
    const baristaCanStart = stationStatusOf(mixedFoodCancelled,'DRINK')==='PENDING' && hasActiveStationLines(mixedFoodCancelled,'DRINK');
    assert.equal(kitchenCanStart,false);
    assert.equal(baristaCanStart,true);
  });

  test('J. Server dest filter prevents cross-contamination', () => {
    const foodCancelledDrinkActive = {
      items:[
        { type:'FOOD', cancelled:true },
        { type:'DRINK', cancelled:false }
      ]
    };
    // New filter: KITCHEN should NOT fetch this order
    assert.equal(destMatchServerSide(foodCancelledDrinkActive,'FOOD'),false);
    assert.equal(destMatchServerSide(foodCancelledDrinkActive,'DRINK'),true);
    // Drink cancelled, food active -> opposite
    const drinkCancelledFoodActive = {
      items:[
        { type:'FOOD', cancelled:false },
        { type:'DRINK', cancelled:true }
      ]
    };
    assert.equal(destMatchServerSide(drinkCancelledFoodActive,'FOOD'),true);
    assert.equal(destMatchServerSide(drinkCancelledFoodActive,'DRINK'),false);
  });
});
