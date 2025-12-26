'use strict';

const EventEmitter = require('events').EventEmitter;
const IcalExpander = require('ical-expander');
const https = require('https');

/**
 * Heuristic detection for all-day events without relying on node-ical dateOnly.
 * Treats events as all-day when:
 *  - start/end are Date objects
 *  - both are exactly at midnight
 *  - duration is a whole number of days (>= 1 day)
 */
function looksAllDayIcalEvent(e) {
  if (!e || !e.startDate || !e.endDate) return false;

  const start = e.startDate.toJSDate ? e.startDate.toJSDate() : e.startDate;
  const end = e.endDate.toJSDate ? e.endDate.toJSDate() : e.endDate;

  if (!(start instanceof Date) || !(end instanceof Date)) return false;

  const isMidnight =
    start.getHours() === 0 && start.getMinutes() === 0 && start.getSeconds() === 0 &&
    end.getHours() === 0 && end.getMinutes() === 0 && end.getSeconds() === 0;

  const durationMs = end.getTime() - start.getTime();
  const oneDayMs = 24 * 60 * 60 * 1000;

  return isMidnight && durationMs >= oneDayMs && (durationMs % oneDayMs) === 0;
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
        this.log(`Failed to load iCal calender: ${this.url} with error ${err}`);
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
      const beforeEvents = (cal.events || []).length;
      const beforeOcc = (cal.occurrences || []).length;

      if (Array.isArray(cal.events)) {
        cal.events = cal.events.filter(e => !looksAllDayIcalEvent(e));
      }

      if (Array.isArray(cal.occurrences)) {
        cal.occurrences = cal.occurrences.filter(o => !looksAllDayIcalEvent(o));
      }

      const afterEvents = (cal.events || []).length;
      const afterOcc = (cal.occurrences || []).length;

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
