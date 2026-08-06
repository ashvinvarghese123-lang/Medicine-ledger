// Computes low-stock and expiring-soon alerts for a hospital's medicine list.
// Pure function, no I/O — easy to test on its own.

const EXPIRY_SOON_DAYS = 30;

function round(n) { return Math.round(n * 100) / 100; }

function usedFor(logs, medId) {
  var total = 0;
  for (var d in logs) {
    var dayEntries = (logs[d] && logs[d][medId]) || [];
    for (var i = 0; i < dayEntries.length; i++) total += Number(dayEntries[i].qty) || 0;
  }
  return round(total);
}

function totalQty(med) {
  return (med.batches || []).reduce(function (s, b) { return s + (Number(b.qty) || 0); }, 0);
}

function remainingTotal(med, logs) {
  return round(totalQty(med) - usedFor(logs, med.id));
}

function statusFor(med, logs) {
  if (!med.batches || med.batches.length === 0) return 'unset';
  var rem = remainingTotal(med, logs);
  if (rem <= 0) return 'empty';
  var tot = totalQty(med);
  var threshold = (med.reorder !== undefined && med.reorder !== null && med.reorder !== '') ? Number(med.reorder) : tot * 0.2;
  if (rem <= threshold) return 'low';
  return 'ok';
}

function monthEndDate(ym) {
  var p = ym.split('-');
  var y = Number(p[0]), m = Number(p[1]);
  var last = new Date(y, m, 0).getDate();
  return ym + '-' + String(last).padStart(2, '0');
}
function effectiveExpiryDate(expiry) {
  if (!expiry) return null;
  return expiry.length === 7 ? monthEndDate(expiry) : expiry; // 'YYYY-MM' -> end of month; full dates pass through
}
function daysUntil(dateStr, todayDate) {
  if (!dateStr) return null;
  var eff = effectiveExpiryDate(dateStr);
  var today = new Date(todayDate.toISOString().slice(0, 10) + 'T00:00:00');
  var target = new Date(eff + 'T00:00:00');
  return Math.round((target - today) / 86400000);
}

// FEFO allocation — mirrors the frontend's allocatedBatches()
function allocatedBatches(med, logs) {
  var batches = (med.batches || []).slice().sort(function (a, b) {
    var ea = a.expiry ? new Date(a.expiry).getTime() : Infinity;
    var eb = b.expiry ? new Date(b.expiry).getTime() : Infinity;
    return ea - eb;
  });
  var used = usedFor(logs, med.id);
  return batches.map(function (b) {
    var qty = Number(b.qty) || 0;
    var consumed = Math.min(qty, Math.max(0, used));
    used -= consumed;
    return { id: b.id, qty: qty, expiry: b.expiry, remaining: round(qty - consumed) };
  });
}

/**
 * Returns { lowStock: [{name, remaining, unit}], expiring: [{name, days, remaining, unit}] }
 */
function computeAlerts(medicines, logs, now) {
  now = now || new Date();
  var lowStock = [];
  var expiring = [];

  (medicines || []).forEach(function (med) {
    var status = statusFor(med, logs);
    if (status === 'low' || status === 'empty') {
      lowStock.push({ name: med.name, unit: med.unit || '', remaining: remainingTotal(med, logs), status: status });
    }
    allocatedBatches(med, logs).forEach(function (b) {
      if (b.remaining > 0 && b.expiry) {
        var days = daysUntil(b.expiry, now);
        if (days <= EXPIRY_SOON_DAYS) {
          expiring.push({ name: med.name, unit: med.unit || '', remaining: b.remaining, days: days, expiry: b.expiry });
        }
      }
    });
  });

  lowStock.sort(function (a, b) { return a.remaining - b.remaining; });
  expiring.sort(function (a, b) { return a.days - b.days; });
  return { lowStock: lowStock, expiring: expiring };
}

// A short, stable fingerprint of the current alert set — used to avoid
// sending the same notification content over and over on every check.
function alertsFingerprint(alerts) {
  var crypto = require('crypto');
  var key = alerts.lowStock.map(function (a) { return a.name + ':' + a.remaining; }).join(',') +
    '|' + alerts.expiring.map(function (a) { return a.name + ':' + a.days; }).join(',');
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

module.exports = { computeAlerts, alertsFingerprint, EXPIRY_SOON_DAYS };
