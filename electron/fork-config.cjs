"use strict";
/**
 * Fork switches (Hanson's fork). Upstream files read these through one-line
 * hooks, so a fork decision lives here instead of as an edit inside upstream
 * code. Add a switch only for a behaviour the fork turns off or on wholesale.
 */
module.exports = {
	/** Upstream's startup announcements are fetched from learnharness.ai and
	 *  point at upstream's own releases, which lack this fork's features.
	 *  Installing one over this build would lose them, so they stay off. */
	startupAnnouncements: false,
};
