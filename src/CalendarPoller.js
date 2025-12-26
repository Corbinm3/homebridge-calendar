'use strict';

const EventEmitter = require('events').EventEmitter;
const IcalExpander = require('ical-expander');
const https = require('https');

/**
 * Detect all-day events without upgrading dependencies.
 *
 * Primary signal (preferred): ical.js sets ICAL.Time.isDate === true for VALUE=DATE
 * (typical all-day VEVENTs use DTSTART;VALUE=DATE / DTEND;VALUE=DATE).
 *
 * Fallback: midnight-to-midnight with DST-tolerant duration check.
 */
function looksAllDayIcalEvent(e) {
  if (!e) return false;

  // Handle both VEVENT and occurrence objects
  const src = (e.startDate && e.endDate) ? e : e.item;
  if (!src || !src.startDate || !src.endDate) return false;

  // 1) Best signal: VALUE=DATE -> isDate === true
  if (src.startDate.isDate === true || src.endDate.isDate === true) {
    return true;
  }

  // 2) Fallback heuristic (DST-tolerant)
  const start = src.startDate.toJSDate ? src.startDate.toJSDate() : src.startDate;
  const end = src.endDate.toJSDate ? src.endDate.toJSDate() : src.endDate;

  if (!(start instanceof Date) || !(end instanceof Date)) return false;

  const startIsMidnight =
    start.getHours() === 0 && start.getMinutes() === 0 && start.getSeconds() === 0;

  const endIsMidnight =
    end.getHours() === 0 && end.getMinutes() === 0 && end.getSeconds() === 0;

  if (!startIsMidnight || !endIsMidnight) return false;

  const durationMs = end.getTime() - start.getTime();
  const oneDayMs = 24 * 60 * 60 * 1000;

  // Allow DST drift (up to 2 hours) per day boundary
  const days = Math.round(durationMs / oneDayMs);
  if (days < 1) return false;

  const driftMs = Math.abs(durationMs - (days * oneDayMs));
  const maxDriftMs = 2 * 60 * 60 * 1000; // 2 hours

  return driftMs <= maxDriftMs;
}

class CalendarPoller extends EventEmitter {

  constructor(log, name, url, interval) {
    super();

    this.log = log;
    this.name = name;

    this._url = url.replace('webcal://', 'https://');
    this._interval = interval;
    this._isStarted = false;
  }

  start() {
    if (this._isStarted === false) {
      this.emit('started');
      this._isStarted = true;
      this._loadCalendar();
    }
  }

  stop() {
    if (this._isStarted === true) {
      this.emit('stopped');
      this._isStarted = false;

      clearTimeout(this._refreshTimer);
      this._refreshTimer = undefined;
    }
  }

  _loadCalendar() {
    // TODO: Make use of HTTP cache control stuff
    this.log(`Updating calendar ${this.name}`);

    https.get(this._url, (resp) => {

      resp.setEncoding('utf8');
      let data = '';

      // A chunk of data has been recieved.
      resp.on('data', (chunk) => {
        data += chunk;
      });

      // The whole response has been received.
      resp.on('end', () => {
        this._refreshCalendar(data);
      });

    }).on('error', (err) => {

      if (err) {
        // Note: original code used this.url, but the member is this._url
        this.log(`Failed to load iCal calender: ${this._url} with error ${err}`);
        this.emit('error', err);
      }

    });
  }

  _refreshCalendar(data) {

    const icalExpander = new IcalExpander({
      ics: data,
      maxIterations: 1000
    });

    const duration = 7; // days
    var now = new Date();
    var next = new Date(now.getTime() + duration * 24 * 60 * 60 * 1000);

    const cal = icalExpander.between(now, next);

    if (cal) {
      // Filter out all-day events/occurrences before downstream processing.
      const beforeEvents = Array.isArray(cal.events) ? cal.events.length : 0;
      const beforeOcc = Array.isArray(cal.occurrences) ? cal.occurrences.length : 0;

      if (Array.isArray(cal.events)) {
        cal.events = cal.events.filter(e => !looksAllDayIcalEvent(e));
      }

      if (Array.isArray(cal.occurrences)) {
        cal.occurrences = cal.occurrences.filter(o => !looksAllDayIcalEvent(o));
      }

      const afterEvents = Array.isArray(cal.events) ? cal.events.length : 0;
      const afterOcc = Array.isArray(cal.occurrences) ? cal.occurrences.length : 0;

      const removed = (beforeEvents - afterEvents) + (beforeOcc - afterOcc);
      if (removed > 0) {
        this.log(`Filtered ${removed} all-day event(s) from calendar ${this.name}`);
      }

      this.emit('data', cal);
    }

    this._scheduleNextIteration();
  }

  _scheduleNextIteration() {
    if (this._refreshTimer !== undefined || this._isStarted === false) {
      return;
    }

    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = undefined;
      this._loadCalendar();
    }, this._interval);
  }

}

module.exports = CalendarPoller;
