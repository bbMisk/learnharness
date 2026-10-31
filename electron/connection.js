const host = document.querySelector("#host");
const error = document.querySelector("#error");
const button = document.querySelector("#connect");
error.textContent = new URLSearchParams(location.search).get("error") || "";
window.lh
	.getConnection()
	.then((settings) => {
		if (settings.mode === "host") host.value = settings.url;
		else document.querySelector('input[value="local"]').checked = true;
	})
	.catch(() => {
		// Keep a reopen error from the query string; it explains more than this does.
		if (!error.textContent) error.textContent = "Could not load the saved connection.";
	});
host.addEventListener("input", () => {
	document.querySelector('input[value="host"]').checked = true;
});
document.querySelector("#connection-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	button.disabled = true;
	error.textContent = "";
	try {
		const url = document.querySelector('input[name="mode"]:checked').value === "host" ? host.value : null;
		const result = await window.lh.setConnection(url);
		if (!result.ok) throw new Error(result.error);
		button.textContent = "Reopening…";
	} catch (failure) {
		error.textContent = failure.message || "Could not connect. Check that the host and Tailscale are running.";
		button.disabled = false;
	}
});
