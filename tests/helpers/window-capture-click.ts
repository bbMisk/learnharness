/** linkedom has no capture phase, so the app-wide double-click guard (a window
 *  capture `click` listener, `useDoubleClickGuard`) would hear a click only after
 *  React had handled it. Run window's capture click listeners first, as a browser
 *  does: their stopPropagation keeps the click from its target and from React. */
export function windowCaptureClicks(window: Window & typeof globalThis) {
	const capture = new Set<EventListener>();
	const isCapture = (options?: boolean | AddEventListenerOptions) => options === true || (typeof options === "object" && !!options.capture);
	const add = window.addEventListener.bind(window);
	const remove = window.removeEventListener.bind(window);
	Object.assign(window, {
		addEventListener: (type: string, listener: EventListener, options?: boolean | AddEventListenerOptions) =>
			type === "click" && isCapture(options) ? void capture.add(listener) : add(type, listener, options),
		removeEventListener: (type: string, listener: EventListener, options?: boolean | EventListenerOptions) =>
			type === "click" && isCapture(options) ? void capture.delete(listener) : remove(type, listener, options),
	});
	const dispatch = window.EventTarget.prototype.dispatchEvent;
	window.EventTarget.prototype.dispatchEvent = function (this: EventTarget, event: Event) {
		if (event.type === "click" && capture.size) {
			Object.assign(event, { target: this });
			for (const listener of [...capture]) listener(event);
			Object.assign(event, { target: null });
			if (event.cancelBubble) return !event.defaultPrevented;
		}
		return dispatch.call(this, event);
	};
}
