(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ReservationCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    const DAY = 86400000, OFFSET = 28800000, MAX_BATCH = 1;
    const PERIOD_MINUTES = [490, 550, 610, 670, 790, 850, 920, 980];
    const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
    const fail = message => { throw new Error(message); };
    const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
    const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
    function semesterStart(config) {
        if (!config || !/^\d{4}-\d{2}-\d{2}$/.test(config.startDate)) fail('Invalid semester date.');
        const start = Date.parse(config.startDate + 'T00:00:00+08:00');
        if (!Number.isFinite(start) || new Date(start + OFFSET).toISOString().slice(0, 10) !== config.startDate || new Date(start + OFFSET).getUTCDay() !== 1) fail('Week 1 must start on a valid Monday.');
        if (!integer(config.totalWeeks, 1, 60) || !integer(config.maxAdvanceWeeks, 0, 60)) fail('Invalid semester week limits.');
        return start;
    }
    function slotParts(id) {
        const match = /^w([1-9]\d*)_d([0-5])_p([1-8])$/.exec(id);
        if (!match) fail('Invalid reservation slot: ' + id);
        return { week: Number(match[1]), day: Number(match[2]), period: Number(match[3]) };
    }
    function slotTime(config, week, day, period) {
        return semesterStart(config) + ((week - 1) * 7 + day) * DAY + (period ? PERIOD_MINUTES[Number(period) - 1] * 60000 : 0);
    }
    function currentWeek(config, now = Date.now()) {
        return Math.max(1, Math.min(config.totalWeeks, Math.floor((now - semesterStart(config)) / (7 * DAY)) + 1));
    }
    function bookings(slot) {
        if (!slot) return [];
        if (Array.isArray(slot.bookings)) return slot.bookings.filter(Boolean);
        if (slot.bookings && typeof slot.bookings === 'object') return Object.values(slot.bookings);
        return [slot];
    }
    function secureSlot(slot) {
        const result = { bookings: {}, usedQuantity: 0 };
        bookings(slot).forEach((old, index) => {
            const id = typeof old.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(old.id) ? old.id : 'legacy_' + index;
            if (own(result.bookings, id) || ['__proto__', 'constructor', 'prototype'].includes(id)) fail('Duplicate or unsafe reservation ID. Review the backup before upgrading.');
            const ownerEmail = old.ownerEmail || old.email;
            const quantity = old.quantity === undefined ? 1 : Number(old.quantity);
            if (!text(ownerEmail, 254) || !text(old.name, 100) || !text(old.className, 120) || !integer(quantity, 1, 1000)) fail('Invalid existing reservation. Review the data before upgrading.');
            result.bookings[id] = {
                id, name: old.name, className: old.className, email: ownerEmail, ownerEmail,
                ownerUid: typeof old.ownerUid === 'string' ? old.ownerUid : '', quantity,
                createdAt: typeof old.createdAt === 'string' && old.createdAt.length <= 64 ? old.createdAt : 'Legacy reservation'
            };
            result.usedQuantity += quantity;
        });
        if (Object.keys(result.bookings).length > 64) fail('Too many reservations in one slot.');
        return result;
    }
    function upgradeCart(cart) {
        if (!integer(cart.capacity, 1, 1000)) fail('Equipment capacity must be a whole number from 1 to 1000.');
        const schedule = {};
        for (const [id, slot] of Object.entries(cart.schedule || {})) {
            slotParts(id);
            const value = secureSlot(slot);
            if (value.usedQuantity > cart.capacity) fail('Existing reservations exceed capacity in ' + id + '. Review them before upgrading.');
            schedule[id] = value;
        }
        return { ...cart, securityVersion: 2, schedule };
    }
    function lockIndex(locks, totalWeeks) {
        const result = {};
        for (const lock of locks) {
            if (!text(lock.cartName, 200) || ['__proto__', 'constructor', 'prototype'].includes(lock.cartName) || !integer(Number(lock.dayIdx), 0, 5) || !integer(Number(lock.periodId), 1, 8) || !integer(Number(lock.startWeek), 1, totalWeeks) || !integer(Number(lock.weeks), 1, totalWeeks) || Number(lock.startWeek) + Number(lock.weeks) - 1 > totalWeeks) fail('Invalid recurring lock.');
            if (!own(result, lock.cartName)) result[lock.cartName] = {};
            for (let week = Number(lock.startWeek); week < Number(lock.startWeek) + Number(lock.weeks); week++) result[lock.cartName][`w${week}_d${lock.dayIdx}_p${lock.periodId}`] = true;
        }
        return result;
    }
    function upgradeSettings(settings) {
        const config = { ...settings.semesterConfig, maxAdvanceWeeks: settings.semesterConfig?.maxAdvanceWeeks ?? 2 };
        return { ...settings, semesterConfig: config, semesterStartMs: semesterStart(config), securityVersion: 2,
            reservationsEnabled: true, lockedSlots: lockIndex(settings.recurringLocks || [], config.totalWeeks) };
    }
    function owns(booking, user) {
        return booking.ownerEmail === user.email && (!booking.ownerUid || booking.ownerUid === user.uid);
    }
    // Rules independently verify each booking delta and the resulting slot total.
    function changeReservations(cart, settings, user, changes, now = Date.now(), admin = false) {
        if (cart.securityVersion !== 2 || settings.securityVersion !== 2 || !settings.reservationsEnabled) fail('Bookings are paused until the security upgrade is complete.');
        if (!changes.length || changes.length > MAX_BATCH || new Set(changes.map(change => change.slotId)).size !== changes.length) fail('Select 1 to ' + MAX_BATCH + ' different slots per batch.');
        const schedule = { ...cart.schedule }, mutationChanges = [];
        for (const change of changes) {
            if (!['create', 'update', 'delete'].includes(change.operation) || typeof change.bookingId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(change.bookingId) || ['__proto__', 'constructor', 'prototype'].includes(change.bookingId)) fail('Invalid reservation change.');
            const { week, day, period } = slotParts(change.slotId);
            if (week > settings.semesterConfig.totalWeeks) fail('Slot is outside the semester.');
            const slot = secureSlot(schedule[change.slotId]), old = slot.bookings[change.bookingId];
            if (change.operation !== 'create' && !old) fail('This reservation no longer exists.');
            if (change.operation === 'create' && old) fail('Reservation ID already exists.');
            if (!admin && old && !owns(old, user)) fail('You can only change your own reservations.');
            if (!admin && now >= slotTime(settings.semesterConfig, week, day, period)) fail('This period has already started.');
            if (change.operation !== 'delete') {
                if (settings.lockedSlots?.[change.cartName]?.[change.slotId]) fail('This slot is locked.');
                if (!admin && (day === 5 && !settings.allowSaturday || week > currentWeek(settings.semesterConfig, now) + settings.semesterConfig.maxAdvanceWeeks)) fail('This slot is not open for booking.');
                const input = change.booking;
                if (!text(input.name, 100) || !text(input.className, 120) || !integer(input.quantity, 1, cart.capacity)) fail('Enter a name, subject and valid whole-number quantity.');
                const ownerEmail = old?.ownerEmail || user.email;
                slot.bookings[change.bookingId] = {
                    id: change.bookingId, name: input.name.trim(), className: input.className.trim(), quantity: input.quantity,
                    ownerEmail, email: ownerEmail, ownerUid: old ? (old.ownerUid || (ownerEmail === user.email ? user.uid : '')) : user.uid,
                    createdAt: old?.createdAt || new Date(now).toISOString()
                };
            } else delete slot.bookings[change.bookingId];
            const updated = secureSlot(slot);
            if (updated.usedQuantity > cart.capacity) fail('Not enough devices remain in this slot.');
            schedule[change.slotId] = updated;
            mutationChanges.push({ week, day, period, bookingId: change.bookingId });
        }
        return { schedule, changes: mutationChanges, slotIds: changes.map(change => change.slotId) };
    }
    function stable(value) {
        if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
        if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
        return JSON.stringify(value);
    }
    return { DAY, OFFSET, MAX_BATCH, PERIOD_MINUTES, semesterStart, slotParts, slotTime, currentWeek, bookings, secureSlot, upgradeCart, upgradeSettings, lockIndex, owns, changeReservations, stable };
});
