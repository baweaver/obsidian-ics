const ical = require('node-ical');
import { tz } from 'moment-timezone';
import { moment } from "obsidian";

export function extractMeetingInfo(e: any): { callUrl: string, callType: string } {

	// Check for Google Meet conference data
	if (e["GOOGLE-CONFERENCE"]) {
		return { callUrl: e["GOOGLE-CONFERENCE"], callType: 'Google Meet' };
	}
	// Check if the location contains a Zoom link
	if (e.location && e.location.includes('zoom.us')) {
		return { callUrl: e.location, callType: 'Zoom' };
	}
	if (e.description) {
		const skypeMatch = e.description.match(/https:\/\/join.skype.com\/[a-zA-Z0-9]+/);
		if (skypeMatch) {
			return { callUrl: skypeMatch[0], callType: 'Skype' };
		}

		const teamsMatch = e.description.match(/(https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^>]+)/);
		if (teamsMatch) {
			return { callUrl: teamsMatch[0], callType: 'Microsoft Teams' };
		}
	}
	return { callUrl: null, callType: null };
}

export function filterMatchingEvents(icsArray: any[], dayToMatch: string) {
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
	icsArray.forEach(origEvent => {

		// Add recurrences moved to dayToMatch
		if (origEvent.recurrences !== undefined) {
			for (let date in origEvent.recurrences) {
				const recurrence = origEvent.recurrences[date];
				if (recurrence.start.toISOString().slice(0, 10) === rangeStart.toISOString().slice(0, 10)) {
					matchingRecurringEvents.push(recurrence);
				}
			}
		}

		if (typeof origEvent.rrule !== 'undefined') {
			const duration = extractDuration(origEvent);

			// Complicated case - if an RRULE exists, handle multiple recurrences of the event.
			// For recurring events, get the set of event start dates that fall within the range
			// of dates we're looking for.
			var dates = origEvent.rrule.between(rangeStart.toDate(), rangeEnd.toDate(), true, () => {
				return true;
			});

			// Loop through the set of date entries to see which recurrences should be included.
			dates.forEach(date => {
				let curDuration = duration;
				let curEvent = origEvent;
				let skip = false;

				// Use just the date of the recurrence to look up overrides and exceptions (i.e. chop off time information)
				const dateLookupKey = date.toISOString().slice(0, 10);

				if (origEvent.exdate !== undefined && curEvent.exdate[dateLookupKey] !== undefined) {
					// If there's no recurrence override, check for an exception date.  Exception dates represent exceptions to the rule.
					// This date is an exception date, which means we should skip it in the recurrence pattern.
					skip = true;
				}

				// For each date that we're checking, it's possible that there is a recurrence override for that one day.
				if (curEvent.recurrences !== undefined && curEvent.recurrences[dateLookupKey] !== undefined) {
					// override event
					curEvent = curEvent.recurrences[dateLookupKey];
					//override duration
					curDuration = extractDuration(curEvent);
				}

				//if this is the first instance of the event, we don't want it picked up here
				if (moment(date).isSame(curEvent.start)) {
					skip = true;
				}

				if (!skip)
					matchingRecurringEvents.push(cloneRecurringEvent(origEvent, curEvent, date, curDuration));
			});
		}
	});

	return matchingRecurringEvents;

}

function extractDuration(event: any) {
	return (Number.parseInt(moment(event.end).format('x'), 10) - Number.parseInt(moment(event.start).format('x'), 10));

}

function applyTzOffset(origEvent: any, event: any, date: any) {
	if (origEvent.rrule != undefined && origEvent.rrule.origOptions.tzid) {
		// tzid present on the rrule
		const eventTimeZone = tz.zone(origEvent.rrule.origOptions.tzid);
		const localTimeZone = tz.zone(tz.guess());
		const offset = localTimeZone.utcOffset(date) - eventTimeZone.utcOffset(date);
		return moment(date).add(offset, 'minutes');
	} else {
		// tzid not present on rrule (calculate offset from original start)
		return moment(new Date(date.setHours(date.getHours() - ((event.start.getTimezoneOffset() - date.getTimezoneOffset()) / 60))));
	}
}

function cloneRecurringEvent(origEvent: any, event: any, date: any, duration: any) {
	let startDate = applyTzOffset(origEvent, event, date);
	let endDate = moment(Number.parseInt(moment(startDate).format('x'), 10) + duration, 'x');

	return {
		description: event.description,
		summary: `${event.summary} (recurring)`,
		start: startDate.toDate(),
		end: endDate.toDate(),
		location: event.location,
	};
}

export function parseIcs(ics: string) {
	var data = ical.parseICS(ics);
	var vevents = [];

	for (let i in data) {
		if (data[i].type != "VEVENT")
			continue;
		vevents.push(data[i]);
	}
	return vevents;
}
