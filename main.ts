import {
	MarkdownView
} from 'obsidian';

import {
	Calendar,
	ICSSettings,
	DEFAULT_SETTINGS,
} from "src/settings/ICSSettings";

import ICSSettingsTab from "src/settings/ICSSettingsTab";

import {
	getDateFromFile
} from "obsidian-daily-notes-interface";

import {
	Plugin,
	request
} from 'obsidian';

var _ = require('lodash');
const ical = require('node-ical');
const moment = require('moment');

export default class ICSPlugin extends Plugin {
	data: ICSSettings;

	async addCalendar(calendar: Calendar): Promise<void> {
        this.data.calendars = {
            ...this.data.calendars,
			[calendar.icsName]: calendar 
        };
        await this.saveSettings();
    }

	async removeCalendar(calendar: Calendar) {
        if (this.data.calendars[calendar.icsName]) {
            delete this.data.calendars[calendar.icsName];
        }
        await this.saveSettings();
    }

	async onload() {
		console.log('loading ics plugin');
		await this.loadSettings();
		this.addSettingTab(new ICSSettingsTab(this.app, this));
		this.addCommand({
			id: "import_events",
			name: "import events",
			hotkeys: [{
				modifiers: ["Alt", "Shift"],
				key: 'T',
			}, ],
			callback: async () => {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				const fileDate = getDateFromFile(activeView.file, "day").format("YYYY-MM-DD");
				var mdArray: string[] = [];

				for (const calendar in this.data.calendars) {
					const calendarSetting = this.data.calendars[calendar];
					console.log(calendarSetting);
					var icsArray: any[] = [];
					var icsArray = parseIcs(await request({
						url: calendarSetting.icsUrl
					}));
					const todayEvents = filterMatchingEvents(icsArray, fileDate);
					console.log(todayEvents);
	
					todayEvents.forEach((e) => {
						mdArray.push(`- [ ] ${moment(e.start).format("HH:mm")} ${calendarSetting.icsName} ${e.summary} ${e.location}`.trim());
					});
				}

				activeView.editor.replaceRange(mdArray.sort().join("\n"), activeView.editor.getCursor());
			}
		});
	}

	onunload() {
		console.log('unloading ics plugin');
	}

	async loadSettings() {
		this.data = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.data);
	}
}

function filterMatchingEvents(icsArray: any[], dayToMatch: string) {
	var matchingEvents = [];
	matchingEvents = findRecurringEvents(icsArray, dayToMatch);

	// find non-recurring events on the day
	icsArray.map((e) => {
		if (moment(e.start).isSame(dayToMatch, "day")) {
			matchingEvents.push(e);
		}
	});

	return matchingEvents;
}

function findRecurringEvents(icsArray: any[], dayToMatch: string) {
	var matchingRecurringEvents: any[] = [];

	const rangeStart = moment(dayToMatch);
	const rangeEnd = moment(dayToMatch).add(1439, 'minutes');
	// console.log(rangeStart.format(), rangeEnd.format());

	for (const k in icsArray) {
		const event = icsArray[k];
		const title = event.summary;

		// When dealing with calendar recurrences, you need a range of dates to query against,
		// because otherwise you can get an infinite number of calendar events.
		let startDate = moment(event.start);
		let endDate = moment(event.end);

		// Calculate the duration of the event for use with recurring events.
		const duration = Number.parseInt(endDate.format('x'), 10) - Number.parseInt(startDate.format('x'), 10);

		if (typeof event.rrule !== 'undefined') {
			// Complicated case - if an RRULE exists, handle multiple recurrences of the event.

			// For recurring events, get the set of event start dates that fall within the range
			// of dates we're looking for.
			var dates = event.rrule.between(rangeStart.toDate(), rangeEnd.toDate(), true, () => {
				return true;
			});

			// The "dates" array contains the set of dates within our desired date range range that are valid
			// for the recurrence rule.  *However*, it's possible for us to have a specific recurrence that
			// had its date changed from outside the range to inside the range.  One way to handle this is
			// to add *all* recurrence override entries into the set of dates that we check, and then later
			// filter out any recurrences that don't actually belong within our range.
			if (event.recurrences !== undefined) {
				for (const r in event.recurrences) {
					// Only add dates that weren't already in the range we added from the rrule so that
					// we don't double-add those events.
					if (moment(new Date(r)).isBetween(rangeStart, rangeEnd) !== true) {
						dates.push(new Date(r));
					}
				}
			}

			// Loop through the set of date entries to see which recurrences should be included.
			for (const i in dates) {
				const date = dates[i];
				let curEvent = event;
				let includeRecurrence = true;
				let curDuration = duration;

				let startDate = moment(date);

				// Use just the date of the recurrence to look up overrides and exceptions (i.e. chop off time information)
				const dateLookupKey = date.toISOString().slice(0, 10);

				// For each date that we're checking, it's possible that there is a recurrence override for that one day.
				if (curEvent.recurrences !== undefined && curEvent.recurrences[dateLookupKey] !== undefined) {
					// We found an override, so for this recurrence, use a potentially different title, start date, and duration.
					curEvent = curEvent.recurrences[dateLookupKey];
					startDate = moment(curEvent.start);
					curDuration = Number.parseInt(moment(curEvent.end).format('x'), 10) - Number.parseInt(startDate.format('x'), 10);
				} else if (curEvent.exdate !== undefined && curEvent.exdate[dateLookupKey] !== undefined) {
					// If there's no recurrence override, check for an exception date.  Exception dates represent exceptions to the rule.
					// This date is an exception date, which means we should skip it in the recurrence pattern.
					includeRecurrence = false;
				}

				// Set the the end date from the regular event or the recurrence override.
				let endDate = moment(Number.parseInt(startDate.format('x'), 10) + curDuration, 'x');

				// If this recurrence ends before the start of the date range, or starts after the end of the date range,
				// don't process it.
				if (endDate.isBefore(rangeStart) || startDate.isAfter(rangeEnd)) {
					includeRecurrence = false;
				}

				if (includeRecurrence === true) {
					matchingRecurringEvents.push(cloneRecurringEvent(curEvent, startDate, endDate));
				}
			}
		}
	}
	return matchingRecurringEvents;

	function cloneRecurringEvent(curEvent: any, startDate: any, endDate: any) {
		var matchEvent = _.cloneDeep(curEvent);
		matchEvent.summary = `${curEvent.summary} (recurring)`;
		matchEvent.start = startDate.toDate();
		matchEvent.end = endDate.toDate();
		matchEvent.rrule = undefined;
		matchEvent.exdate = [];
		matchEvent.recurrences = undefined;
		return matchEvent;
	}
}

function parseIcs(ics: string) {
	var data = ical.parseICS(ics);
	var vevents = [];

	for (let i in data) {
		if (data[i].type != "VEVENT") continue;
		vevents.push(data[i]);
	}
	return vevents;
}
