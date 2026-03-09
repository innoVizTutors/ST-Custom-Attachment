// ============================================================================
// x-1851424-st-doli-attachment — ServiceNow Custom Attachment Component
// ============================================================================
//
// OVERVIEW:
// This is a ServiceNow UI Framework web component built with @servicenow/ui-core
// and rendered via the Snabbdom virtual-DOM renderer.
//
// PURPOSE:
// Provides a drag-and-drop / click-to-browse file attachment widget that sits
// on a ServiceNow record (e.g. an Incident). It handles uploading, listing,
// downloading and deleting attachments via the ServiceNow Attachment REST API.
//
// SPECIAL BEHAVIOUR — DOLI ENCODING:
// ServiceNow rejects file types it doesn't recognise (e.g. .stif, .klarf, .001).
// To work around this, unrecognised files are re-encoded before upload:
//   - The file content is read as text and wrapped in a text/plain Blob
//   - The filename is renamed:  report.stif  →  report#$stif.DOLI
// On download, the original filename is restored by reversing the encoding.
// Standard types (pdf, jpg, docx …) are uploaded exactly as-is.
//
// EXECUTION ENTRY POINT:
// The browser loads this module, which runs top-to-bottom:
//   1. Imports are resolved
//   2. Helper functions and constants are defined
//   3. `createCustomElement(...)` at the bottom registers the component with
//      the ServiceNow UI Framework — THIS is where the component lifecycle begins.
//
// COMPONENT LIFECYCLE FLOW:
//   a. ServiceNow renders the element on the page
//   b. `view()` is called for the first render
//   c. `view()` detects the component is not yet initialised and triggers
//      `LOAD_ATTACHMENTS` to fetch existing attachments from the server
//   d. User interactions (click, drop, delete, download) dispatch action events
//   e. `actionHandlers` process those events, update state, and re-trigger `view()`
//
// ============================================================================

import { createCustomElement } from "@servicenow/ui-core";
import snabbdom from "@servicenow/ui-renderer-snabbdom";
import styles from "./styles.scss";
import "@servicenow/now-button";
import "@servicenow/now-icon";

// ============================================================================
// SECTION 1 — SERVICENOW AUTH & HTTP UTILITIES
// ============================================================================
// These helpers handle authenticated communication with the ServiceNow REST API.
// Every API call must include an X-UserToken header for CSRF protection.

//
//  * Retrieves the current user's CSRF token.
//  * ServiceNow exposes this as `window.g_ck` on authenticated pages.
//  * Falls back to reading it from the session cookie if the global is unavailable.

function getToken() {
	return (
		window.g_ck ||
		document.cookie.match(/glide_user_activity=([^;]+)/)?.[1] ||
		""
	);
}

//
//  * Authenticated fetch wrapper for ServiceNow REST API calls that return JSON.
//  * Automatically attaches credentials (session cookies) and the CSRF token.
//  * Throws an Error with the raw response body if the HTTP status is not OK,
//  * so callers can parse the error detail in `friendlyErrorMessage()`.

function snFetch(url, options = {}) {
	return fetch(url, {
		credentials: "same-origin", // send session cookies
		...options,
		headers: {
			"X-UserToken": getToken(), // CSRF token required by ServiceNow
			...options.headers,
		},
	}).then((res) => {
		if (!res.ok)
			return res.text().then((t) => {
				throw new Error(`${res.status}: ${t}`);
			});
		return res.json();
	});
}

// ============================================================================
// SECTION 2 — DOLI FILE ENCODING / DECODING
// ============================================================================
// ServiceNow's MIME-type validator blocks uploads of file extensions it doesn't
// recognise. The DOLI encoding scheme works around this by disguising unknown
// files as plain-text uploads with a .DOLI extension.
//
// ENCODE:  report.stif  →  report#$stif.DOLI   (uploaded as text/plain)
// DECODE:  report#$stif.DOLI  →  report.stif   (shown to the user)
//
// Only non-native extensions go through this process. Standard extensions
// (pdf, jpg, docx …) are uploaded exactly as-is with their real MIME type.

//
//  * All extensions that ServiceNow natively accepts without MIME validation issues.
//  * Files with these extensions upload as-is — no DOLI encoding needed.
//  * Any extension NOT in this set will be DOLI-encoded before upload.

const SERVICENOW_NATIVE_EXTENSIONS = new Set([
	"pdf",
	"doc",
	"docx",
	"xls",
	"xlsx",
	"ppt",
	"pptx",
	"csv",
	"jpg",
	"jpeg",
	"png",
	"gif",
	"bmp",
	"webp",
	"svg",
	"tiff",
	"tif",
	"mp3",
	"mp4",
	"wav",
	"avi",
	"mov",
	"wmv",
	"zip",
	"rar",
	"7z",
	"tar",
	"gz",
	"txt",
	"log",
	"md",
	"rtf",
	"xml",
	"json",
	"js",
	"ts",
	"html",
	"htm",
	"css",
	"py",
	"java",
	"sh",
	"sql",
	"eml",
	"msg",
]);

//
//  * Returns true if this extension is NOT natively supported by ServiceNow,
//  * meaning it must be wrapped in DOLI encoding before upload.

function needsDOLIEncoding(ext) {
	return !SERVICENOW_NATIVE_EXTENSIONS.has(ext.toLowerCase());
}

//
//  * Returns the storage filename for a file.
//  * - If the extension is natively supported → filename unchanged
//  * - If the extension needs encoding       → report.stif becomes report#$stif.DOLI
//  *
//  * @param {File}     file        - The browser File object
//  * @param {string[]} allowedExts - Expanded list of allowed extensions (from the property)

function encodeFileName(file, allowedExts) {
	const ext = file.name.split(".").pop().toLowerCase();
	// Leave the filename alone if the extension isn't in the allowed list
	if (!allowedExts || !allowedExts.includes(ext)) return file.name;
	// Leave the filename alone if ServiceNow already understands this extension
	if (!needsDOLIEncoding(ext)) return file.name;
	const baseName = file.name.substring(0, file.name.lastIndexOf("."));
	return `${baseName}#$${ext}.DOLI`;
}

//
//  * Reverses DOLI encoding to restore the original filename for display/download.
//  * report#$stif.DOLI → report.stif
//  * Any filename not matching the DOLI pattern is returned unchanged.

function decodeFileName(storedName) {
	const match = storedName.match(/^(.+)#\$([^.]+)\.DOLI$/i);
	if (match) return `${match[1]}.${match[2]}`;
	return storedName;
}

// ============================================================================
// SECTION 3 — ERROR MESSAGE FORMATTING
// ============================================================================
// ServiceNow REST API errors arrive as raw JSON strings embedded in Error
// messages (e.g. "400: {"error":{"message":"Invalid file type"}}").
// This section parses those payloads into plain human-readable sentences.

//
//  * Converts a raw API error into a user-friendly string.
//  *
//  * @param {Error}  err     - The caught error object
//  * @param {string} context - Prefix describing the operation, e.g. 'Failed to upload "file.pdf"'
//  * @returns {string}       - A readable error message shown in the toast notification

function friendlyErrorMessage(err, context) {
	const raw = err && err.message ? err.message : String(err || "");

	// Try to parse the JSON payload embedded in the error message
	const jsonMatch = raw.match(/^\d+:\s*(\{.*\})$/s);
	if (jsonMatch) {
		try {
			const parsed = JSON.parse(jsonMatch[1]);
			const status = parsed.error && parsed.error.message;
			const detail = parsed.error && parsed.error.detail;
			const statusCode = raw.match(/^(\d+):/)?.[1];

			if (status) {
				// Map known ServiceNow error messages to friendly text
				if (/invalid file type/i.test(status))
					return `${context}: The file type is not permitted by the server.`;
				if (/not an authorized file extension/i.test(status))
					return `${context}: This file extension is not authorized.`;
				if (/maximum attachment size/i.test(status))
					return `${context}: The file exceeds the maximum allowed size.`;
				if (/not logged in|session/i.test(status))
					return `${context}: Your session has expired. Please refresh the page and try again.`;
				if (
					/unauthorized|forbidden/i.test(status) ||
					statusCode === "401" ||
					statusCode === "403"
				)
					return `${context}: You do not have permission to perform this action.`;
				// Fall back to the raw error message + optional detail
				return `${context}: ${status}${detail ? ` (${detail})` : ""}`;
			}

			// Handle HTTP status codes without a message body
			if (statusCode === "401" || statusCode === "403")
				return `${context}: You do not have permission to perform this action.`;
			if (statusCode === "404")
				return `${context}: The requested resource was not found.`;
			if (statusCode === "500")
				return `${context}: A server error occurred. Please try again later.`;
		} catch (_) {}
	}

	// Network-level failures (no HTTP response at all)
	if (/failed to fetch|networkerror|network request failed/i.test(raw))
		return `${context}: A network error occurred. Please check your connection and try again.`;

	return `${context}: Something went wrong. Please try again or contact your administrator.`;
}

// ============================================================================
// SECTION 4 — TOAST NOTIFICATION SYSTEM
// ============================================================================
// Toasts are the stacked success/error banners shown below the upload zone.
// Each toast auto-dismisses after 15 seconds and has an x button for manual
// dismissal.
//
// WHY MODULE-LEVEL STATE:
// ServiceNow's `updateState()` does not support functional updates
// (e.g. `updateState(prev => ...)`) — each call overwrites the full state slice.
// To safely accumulate multiple toasts, we maintain the list in module-level
// variables (`_toasts`, `_toastTimers`) outside of component state, then push
// a snapshot into state on every change.

// Live list of active toast objects: { id, type: 'success'|'error', text }
let _toasts = [];

// Map of toast id to setTimeout handle, used to cancel auto-dismiss on manual close
let _toastTimers = {};

//
//  * Removes a toast by id, cancels its auto-dismiss timer, and updates the UI.
//  * Called either by the x button (manual) or automatically after 15 seconds.

function dismissToast(updateState, id) {
	clearTimeout(_toastTimers[id]);
	delete _toastTimers[id];
	_toasts = _toasts.filter((t) => t.id !== id);
	updateState({ toasts: [..._toasts] });
}

//
//  * Creates a new toast, adds it to the stack, and schedules auto-dismissal.
//  * @param {string} type - 'success' or 'error'
//  * @param {string} text - Message to display

function addToast(updateState, type, text) {
	const id = Date.now() + "_" + Math.random().toString(36).slice(2);
	const toast = { id, type, text };
	_toasts = [..._toasts, toast];
	updateState({ toasts: [..._toasts] });
	// Auto-dismiss after 15 seconds
	_toastTimers[id] = setTimeout(() => dismissToast(updateState, id), 15000);
}

// Convenience wrapper — shows a green success toast
function toastSuccess(updateState, text) {
	addToast(updateState, "success", text);
}

// Convenience wrapper — shows a red error toast
function toastError(updateState, text) {
	addToast(updateState, "error", text);
}

// ============================================================================
// SECTION 5 — SERVICENOW ATTACHMENT REST API CALLS
// ============================================================================
// These four functions are the only places that talk to the ServiceNow server.
// They map directly to the four CRUD operations on attachments.

//
//  * UPLOAD — POST /api/now/attachment/upload
//  *
//  * Uploads a single file to the ServiceNow attachment table.
//  * For non-native extensions (stif, klarf, 001 ...):
//  *   - Reads the file as text
//  *   - Wraps it in a text/plain Blob (so ServiceNow's MIME checker accepts it)
//  *   - Renames it to the DOLI-encoded filename
//  * For native extensions (pdf, jpg, docx ...):
//  *   - Uploads the file directly with its real MIME type and original name
//  *
//  * @param {File}     file        - Browser File object selected by the user
//  * @param {string}   tableName   - ServiceNow table (e.g. "incident")
//  * @param {string}   tableSysId  - sys_id of the record to attach to
//  * @param {string[]} allowedExts - Expanded allowed extensions list (for DOLI decision)

function uploadToSysAttachment(file, tableName, tableSysId, allowedExts) {
	const uploadName = encodeFileName(file, allowedExts); // possibly DOLI-renamed
	const ext = file.name.split(".").pop().toLowerCase();

	// For non-native extensions: re-wrap as text/plain with DOLI filename
	// For native extensions: keep the real file content and MIME type
	const prepareFile = needsDOLIEncoding(ext)
		? file.text().then(
				(text) =>
					new File([new Blob([text], { type: "text/plain" })], uploadName, {
						type: "text/plain",
					}),
			)
		: Promise.resolve(new File([file], uploadName, { type: file.type }));

	return prepareFile.then((uploadFile) => {
		const formData = new FormData();
		formData.append("table_name", tableName);
		formData.append("table_sys_id", tableSysId);
		formData.append("uploadFile", uploadFile);

		return fetch("/api/now/attachment/upload", {
			method: "POST",
			credentials: "same-origin",
			headers: {
				"X-UserToken": getToken(),
				Accept: "application/json",
			},
			body: formData,
		})
			.then((res) => {
				if (!res.ok)
					return res.text().then((t) => {
						throw new Error(`${res.status}: ${t}`);
					});
				return res.json();
			})
			.then((json) => json.result);
	});
}

//
//  * FETCH LIST — GET /api/now/attachment
//  *
//  * Retrieves all attachment metadata records for a given table record.
//  * Returns an array of attachment objects from the ServiceNow API.
//  * Silently returns [] on error so the UI doesn't break if the fetch fails.
//  *
//  * @param {string} tableName  - ServiceNow table (e.g. "incident")
//  * @param {string} tableSysId - sys_id of the record

function fetchAttachments(tableName, tableSysId) {
	const q = `table_sys_id=${tableSysId}^table_name=${tableName}`;
	const fields =
		"sys_id,file_name,size_bytes,content_type,sys_created_on,sys_created_by";
	return snFetch(
		`/api/now/attachment?sysparm_query=${encodeURIComponent(q)}&sysparm_fields=${fields}&sysparm_display_value=true`,
	)
		.then((json) => json.result || [])
		.catch((err) => {
			console.error("Fetch error:", err);
			return [];
		});
}

//
//  * DELETE — DELETE /api/now/attachment/{sys_id}
//  *
//  * Permanently deletes a single attachment by its sys_id.
//  * ServiceNow returns 204 No Content on success, or 200 in some versions.
//  *
//  * @param {string} sysId - sys_id of the attachment record to delete

function deleteAttachment(sysId) {
	return fetch(`/api/now/attachment/${sysId}`, {
		method: "DELETE",
		credentials: "same-origin",
		headers: { "X-UserToken": getToken() },
	}).then((res) => {
		if (res.status === 204 || res.status === 200) return { deleted: true };
		return res.text().then((t) => {
			throw new Error(`${res.status}: ${t}`);
		});
	});
}

//
//  * DOWNLOAD — GET /api/now/attachment/{sys_id}/file
//  *
//  * Streams the attachment binary from ServiceNow, creates a temporary object URL,
//  * and triggers a browser download via a hidden <a> click.
//  * Decodes the DOLI filename back to the original name before downloading,
//  * so the user sees "report.stif" rather than "report#$stif.DOLI".
//  *
//  * @param {string} sysId          - sys_id of the attachment
//  * @param {string} storedFileName - The filename as stored in ServiceNow (may be DOLI-encoded)

function downloadAttachment(sysId, storedFileName) {
	const downloadName = decodeFileName(storedFileName); // restore original name
	return fetch(`/api/now/attachment/${sysId}/file`, {
		credentials: "same-origin",
		headers: { "X-UserToken": getToken() },
	})
		.then((res) => {
			if (!res.ok)
				throw new Error(
					`${res.status}: {"error":{"message":"Download failed"}}`,
				);
			return res.blob();
		})
		.then((blob) => {
			// Create a temporary download link and click it programmatically
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = downloadName;
			a.click();
			URL.revokeObjectURL(url); // clean up memory
		});
}

// ============================================================================
// SECTION 6 — DISPLAY UTILITY HELPERS
// ============================================================================
// Small pure functions used by the view to format data for display.

//
//  * Maps a filename to a logical file-type category used to pick the correct icon.
//  * Returns one of: 'image' | 'pdf' | 'doc' | 'sheet' | 'archive' | 'text' | 'code' | 'other'

function getFileType(fileName = "") {
	const ext = fileName.split(".").pop().toLowerCase();
	if (["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp"].includes(ext))
		return "image";
	if (ext === "pdf") return "pdf";
	if (["doc", "docx"].includes(ext)) return "doc";
	if (["xls", "xlsx", "csv"].includes(ext)) return "sheet";
	if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "archive";
	if (["txt", "log", "md"].includes(ext)) return "text";
	if (["xml", "json", "js", "ts", "html", "css", "py", "java"].includes(ext))
		return "code";
	return "other";
}

// Converts raw bytes to a human-readable size string (B / KB / MB)
function formatSize(bytes) {
	const b = Number(bytes) || 0;
	if (b < 1024) return `${b} B`;
	if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
	return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

// Formats a ServiceNow datetime string (e.g. "2024-01-15 09:30:00") to "Jan 15, 2024, 09:30 AM"
function formatDate(dateStr) {
	if (!dateStr) return "";
	return new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	}).format(new Date(dateStr));
}

// ============================================================================
// SECTION 7 — EXTENSION PARSING & VALIDATION
// ============================================================================
// The component accepts an `extensions` property like "stif,pdf,000-100".
// These functions parse that string into an expanded list used for validation,
// and also produce a compact display form for the hint text and error messages.

//
//  * Expands a single extension token.
//  * - Plain token:    "stif"    -> ["stif"]
//  * - Numeric range:  "000-100" -> ["000", "001", ..., "100"]
//  * Zero-padding is preserved from the start of the range (e.g. "000" stays 3 digits).

function expandExtensionToken(token) {
	const rangeMatch = token.match(/^(\d+)-(\d+)$/);
	if (rangeMatch) {
		const start = parseInt(rangeMatch[1], 10);
		const end = parseInt(rangeMatch[2], 10);
		const pad = rangeMatch[1].length; // width of the start token (e.g. "000" → pad=3)
		const result = [];
		for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
			// Always include the zero-padded form (e.g. "008", "010")
			result.push(String(i).padStart(pad, "0"));
			// Also include the bare numeric string (e.g. "8", "10") so files
			// whose extension has no or different zero-padding still match.
			// e.g. "data.10", "data.08", "data.8" all match range "000-100".
			const bare = String(i);
			if (bare !== String(i).padStart(pad, "0")) {
				result.push(bare);
			}
			// Additionally, for numbers that could appear with partial padding
			// (e.g. "08" for the number 8 when pad=3), generate all intermediate
			// padded widths between bare and fully padded so every real-world
			// variant is covered.
			for (let w = bare.length + 1; w < pad; w++) {
				result.push(String(i).padStart(w, "0"));
			}
		}
		return result;
	}
	return [token.toLowerCase()];
}

//
//  * Parses the full `extensions` property string into a flat deduplicated array
//  * of lowercase extensions used for file validation during upload.
//  *
//  * For numeric ranges both the zero-padded and unpadded forms are included so
//  * that a file with extension ".10" or ".010" both match a range like "000-100".
//  *
//  * Examples:
//  *   "stif,pdf,000-002"  ->  ["stif", "pdf", "000", "001", "002", "1", "2"]
//  *   ""                  ->  []   (no files allowed)

function parseAllowedExtensions(extensionsProp) {
	if (
		!extensionsProp ||
		typeof extensionsProp !== "string" ||
		!extensionsProp.trim()
	)
		return [];
	const tokens = extensionsProp
		.split(/[\s,]+/)
		.map((t) => t.replace(/^\./, "").toLowerCase())
		.filter(Boolean);
	const exts = [];
	tokens.forEach((t) => exts.push(...expandExtensionToken(t)));
	return [...new Set(exts)]; // deduplicate
}

//
//  * Produces a compact, uppercased display string from the raw property value.
//  * Used in the hint text and error messages — shows ranges compactly rather
//  * than expanded (e.g. "000-100" not "000, 001, 002 ...").
//  *
//  * Example:  "stif,pdf,000-100"  ->  "STIF, PDF, 000-100"

function displayExtensionTokens(extensionsProp) {
	if (
		!extensionsProp ||
		typeof extensionsProp !== "string" ||
		!extensionsProp.trim()
	)
		return "";
	return extensionsProp
		.split(/[\s,]+/)
		.map((t) => t.replace(/^\./, "").toUpperCase())
		.filter(Boolean)
		.join(", ");
}

//
//  * Splits an array of files into valid (extension allowed) and rejected groups.
//  * Called during PROCESS_FILES before any upload begins.

function partitionFilesByExtension(files, allowedExts) {
	const valid = [],
		rejected = [];
	files.forEach((file) => {
		const ext = file.name.split(".").pop().toLowerCase();
		(allowedExts.includes(ext) ? valid : rejected).push(file);
	});
	return { valid, rejected };
}

//
//  * Splits an array of files into unique and duplicate groups.
//  * Duplicate detection is done using the DOLI-encoded filename (the stored name),
//  * so it correctly matches files that would end up with the same stored name.
//  * Called during PROCESS_FILES after extension validation.

function partitionFilesByDuplicate(files, existingPreviews, allowedExts) {
	// Build a set of names already stored on the record
	const existingNames = new Set(
		existingPreviews.map((p) => (p.storedName || p.name).toLowerCase()),
	);
	const unique = [],
		duplicates = [];
	files.forEach((file) => {
		// Encode the filename the same way the server will store it
		const encodedName = encodeFileName(file, allowedExts).toLowerCase();
		(existingNames.has(encodedName) ? duplicates : unique).push(file);
	});
	return { unique, duplicates };
}

// ============================================================================
// SECTION 8 — FILE PICKER & ICON HELPERS
// ============================================================================

//
//  * Programmatically opens the browser's native file picker dialog.
//  * Creates a hidden <input type="file" multiple> and clicks it.
//  * Calls `onFiles` callback with the selected File array.

function openNativeFilePicker(onFiles) {
	const input = document.createElement("input");
	input.type = "file";
	input.multiple = true;
	input.onchange = (e) => {
		if (e.target.files && e.target.files.length > 0)
			onFiles(Array.from(e.target.files));
	};
	input.click();
}

//
//  * Maps a file-type category (from `getFileType`) to a now-icon icon name.
//  * Falls back to a generic attachment icon for unknown types.

function getIconForType(fileType) {
	const icons = {
		image: "image-outline",
		pdf: "document-outline",
		doc: "document-outline",
		sheet: "table-outline",
		archive: "folder-outline",
		text: "document-text-outline",
		code: "code-outline",
	};
	return icons[fileType] || "attachment-outline";
}

// ============================================================================
// SECTION 9 — PROPERTY RESOLUTION
// ============================================================================
// The component receives its configuration (recordId, tableName, extensions)
// via the ServiceNow UI Framework `properties` object.
//
// PROBLEM: In local development, the framework sometimes passes an empty
// `properties` object because the HTML attributes haven't been wired up yet.
//
// SOLUTION: `resolveProperties` reads from the framework object first,
// then falls back to reading HTML attributes directly from the DOM element.
// This means local dev works when you set attributes directly on the tag:
//   <x-1851424-st-doli-attachment extensions="pdf,stif" record-id="..." />

//
//  * Returns a fully resolved properties object, with DOM attribute fallbacks
//  * for when the framework hasn't passed values yet (local dev).
//  *
//  * Priority: framework properties object -> DOM attributes -> empty string

function resolveProperties(properties) {
	const el = document.querySelector("x-1851424-st-doli-attachment");
	return {
		recordId:
			(properties && properties.recordId) ||
			(el && (el.getAttribute("record-id") || el.getAttribute("recordid"))) ||
			"",
		tableName:
			(properties && properties.tableName) ||
			(el && (el.getAttribute("table-name") || el.getAttribute("tablename"))) ||
			"",
		extensions:
			(properties && properties.extensions) ||
			(el && el.getAttribute("extensions")) ||
			"",
	};
}

// ============================================================================
// SECTION 10 — VIEW (RENDER FUNCTION)
// ============================================================================
// The `view` function is called by the framework every time `state` changes.
// It returns a virtual-DOM tree (JSX compiled by Snabbdom) describing the UI.
//
// FLOW ON FIRST RENDER:
//   1. state.initialized is false -> check if recordId + tableName are available
//   2a. If yes -> immediately call fetchAttachments and set initialized=true
//   2b. If not yet (properties still loading) -> schedule a retry via _tick,
//       and dispatch LOAD_ATTACHMENTS which will retry once properties arrive
//   3. Render the upload zone, toast stack, and file preview list
//
// FLOW ON SUBSEQUENT RENDERS (after state changes):
//   - initialized is already true -> skip the fetch check
//   - Re-render UI reflecting the updated state (new files, new toasts, etc.)

const view = (state, { updateState, dispatch, properties }) => {
	// ── Initial load: fetch existing attachments ──────────────────────────────
	// On the very first render, if we have the record details, kick off a fetch.
	// If not (properties not yet populated by the framework), schedule a retry.
	if (!state.initialized && !state.loading) {
		const { recordId, tableName } = resolveProperties(state.properties);
		if (recordId && tableName) {
			// Mark as initialized immediately to prevent duplicate fetches
			updateState({ initialized: true, loading: true });
			fetchAttachments(tableName, recordId)
				.then((records) => {
					// Map raw API records to preview objects the view can render
					const previews = records.map((att) => ({
						localId: att.sys_id, // used as key for list rendering
						sys_id: att.sys_id, // real ServiceNow sys_id
						storedName: att.file_name, // DOLI-encoded name as stored
						name: decodeFileName(att.file_name), // decoded display name
						sizeBytes: Number(att.size_bytes),
						fileType: getFileType(decodeFileName(att.file_name)),
						status: "done",
						progress: 100,
						uploadedOn: att.sys_created_on || null,
					}));
					updateState({ previews, loading: false });
				})
				.catch((err) => {
					console.error("Fetch attachments failed:", err);
					updateState({ previews: [], loading: false });
					toastError(
						updateState,
						friendlyErrorMessage(err, "Failed to load attachments"),
					);
				});
		} else {
			// Properties not available yet — nudge a re-render in 300ms and
			// dispatch LOAD_ATTACHMENTS so it retries once properties arrive
			setTimeout(() => updateState({ _tick: Date.now() }), 300);
			dispatch("LOAD_ATTACHMENTS", {});
		}
	}

	// ── Derive UI flags from state ────────────────────────────────────────────
	const readOnlyProp = state.properties && state.properties.readOnly;
	const isReadOnly =
		readOnlyProp === true ||
		(typeof readOnlyProp === "string" && readOnlyProp.toLowerCase() === "true");

	// Build the hint text shown under the upload zone (e.g. "Allowed: PDF, STIF, 000-100")
	const extProp = resolveProperties(state.properties).extensions || "";
	const hintText = extProp
		? `Allowed: ${displayExtensionTokens(extProp)}`
		: "No file types configured.";

	// ── Event handlers ────────────────────────────────────────────────────────
	// Defined inside view so they close over dispatch/updateState.
	// They dispatch named actions handled in the actionHandlers section below.

	// Opens the file picker when the upload zone is clicked (unless read-only)
	const handlePickerClick = () => {
		if (isReadOnly) return;
		openNativeFilePicker((files) => dispatch("PROCESS_FILES", { files }));
	};

	// Handles files dropped onto the upload zone
	const handleDrop = (e) => {
		e.preventDefault();
		if (isReadOnly) return;
		updateState({ isDragging: false });
		const files = Array.from(e.dataTransfer.files);
		if (files.length) dispatch("PROCESS_FILES", { files });
	};

	const toasts = state.toasts || [];

	// ── Virtual DOM ───────────────────────────────────────────────────────────
	// Snabbdom diffs this virtual tree against the previous render and patches
	// only the changed parts of the real DOM.
	return (
		<div className="attachment-widget">
			<div
				className={`upload-zone ${state.isDragging ? "upload-zone--dragging" : ""} ${isReadOnly ? "upload-zone--readonly" : ""}`}
				on-click={handlePickerClick}
				on-drop={handleDrop}
				on-dragover={(e) => {
					e.preventDefault();
					updateState({ isDragging: true }); // highlight zone while dragging
				}}
				on-dragleave={() => updateState({ isDragging: false })}
			>
				<now-icon
					icon="upload-outline"
					size="lg"
					className="upload-zone__icon"
				/>
				<p className="upload-zone__label">
					{state.isDragging
						? "Drop files here"
						: "Click to browse or drag & drop"}
				</p>
				<p className="upload-zone__hint">{hintText}</p>
			</div>

			{toasts.length > 0 && (
				<div className="toast-stack">
					{toasts.map((toast) => (
						<div
							key={toast.id}
							className={`attachment-banner attachment-banner--${toast.type}`}
						>
							<now-icon
								icon={
									toast.type === "success"
										? "check-circle-outline"
										: "circle-x-outline"
								}
								size="sm"
							/>
							<span>{toast.text}</span>
							<button
								className="attachment-banner__close"
								on-click={() => dismissToast(updateState, toast.id)}
							>
								<now-icon icon="close-outline" size="sm" />
							</button>
						</div>
					))}
				</div>
			)}

			{state.previews.length > 0 && (
				<div className="preview-container">
					<div className="preview-container__header">
						<span className="preview-container__title">Attachments</span>
						<span className="preview-container__count">
							{state.previews.filter((f) => f.sys_id).length} /{" "}
							{state.previews.length} saved
						</span>
					</div>

					{state.previews.map((file, index) => (
						<div
							key={file.localId || index}
							className={`preview-card preview-card--${file.status}`}
						>
							<div className="file-icon-wrap">
								<now-icon
									icon={getIconForType(file.fileType)}
									size="md"
									className="file-icon"
								/>
								<span className="file-ext">
									{file.name.split(".").pop().toUpperCase()}
								</span>
							</div>

							<div className="preview-info">
								<p className="preview-info__name" title={file.name}>
									{file.name}
								</p>
								<div className="preview-info__meta">
									<span className="preview-info__size">
										{formatSize(file.sizeBytes)}
									</span>
									{file.uploadedOn && (
										<span className="preview-info__dot"> · </span>
									)}
									{file.uploadedOn && (
										<span>{formatDate(file.uploadedOn)}</span>
									)}
								</div>

								<div className={`status-badge status-badge--${file.status}`}>
									{file.status === "uploading" && (
										<span>
											<now-icon
												icon="loading-outline"
												size="sm"
												className="spin"
											/>{" "}
											Uploading...
										</span>
									)}
									{file.status === "done" && (
										<span>
											<now-icon icon="check-circle-outline" size="sm" /> Saved
										</span>
									)}
									{file.status === "error" && (
										<span>
											<now-icon icon="circle-x-outline" size="sm" /> Upload
											failed
										</span>
									)}
								</div>

								{file.status === "uploading" && (
									<div className="progress-bar">
										<div
											className="progress-bar__fill"
											style={{ width: `${file.progress || 20}%` }}
										/>
									</div>
								)}
							</div>

							<div className="preview-actions">
								{file.sys_id && (
									<button
										className="action-btn action-btn--download"
										title="Download"
										on-click={() => dispatch("DOWNLOAD_FILE", { file })}
									>
										<now-icon icon="download-outline" size="sm" />
									</button>
								)}
								{file.sys_id && !isReadOnly && (
									<button
										className="action-btn action-btn--delete"
										title="Delete"
										on-click={() => dispatch("DELETE_FILE", { file, index })}
									>
										<now-icon icon="trash-outline" size="sm" />
									</button>
								)}
							</div>
						</div>
					))}
				</div>
			)}

			{state.previews.length === 0 && !state.loading && (
				<div className="attachment-empty">
					<now-icon icon="attachment-outline" size="lg" />
					<p>No attachments yet</p>
				</div>
			)}

			{state.loading && (
				<div className="attachment-loading">
					<now-icon icon="loading-outline" size="md" className="spin" />
					<span>Loading attachments...</span>
				</div>
			)}
		</div>
	);
};

// ============================================================================
// SECTION 11 — COMPONENT REGISTRATION  ← EXECUTION ENTRY POINT
// ============================================================================
// `createCustomElement` is the last thing called when this module loads.
// It registers the web component with the ServiceNow UI Framework.
//
// After registration the framework:
//   1. Instantiates the component whenever <x-1851424-st-doli-attachment>
//      appears in the DOM
//   2. Calls `view(state, helpers)` to produce the initial render
//   3. Re-calls `view` whenever updateState() is called (state changes)
//   4. Routes dispatched action strings to the matching actionHandler below

createCustomElement("x-1851424-st-doli-attachment", {
	renderer: { type: snabbdom }, // Snabbdom virtual-DOM engine

	view, // render function defined in Section 10
	styles, // imported SCSS — scoped to this component by the build tool

	// ── Property schema ───────────────────────────────────────────────────────
	// Defines the inputs this component accepts from UI Builder or HTML attributes.
	// All default to "" — resolveProperties() provides DOM-attribute fallbacks.
	properties: {
		recordId: { default: "" }, // sys_id of the record to attach files to
		tableName: { default: "" }, // ServiceNow table name (e.g. "incident")
		readOnly: { default: "" }, // "true" hides upload/delete controls
		extensions: { default: "" }, // allowed types e.g. "stif,pdf,000-100"
	},

	// ── Initial state ─────────────────────────────────────────────────────────
	// Starting values for all state properties.
	// updateState({ key: value }) merges changes into this object and
	// triggers a re-render via view().
	initialState: {
		previews: [], // array of attachment preview objects
		isDragging: false, // true while a file is dragged over the upload zone
		loading: false, // true while the attachment list is being fetched
		toasts: [], // active toast notification objects { id, type, text }
		initialized: false, // flipped to true after the first successful fetch
		_tick: 0, // dummy counter used to force a re-render on retry
		_polling: false, // reserved for future use
	},

	// ── Action handlers ───────────────────────────────────────────────────────
	// Each key is an action name that can be dispatched from the view or other handlers.
	// Handlers receive { action, state, updateState, dispatch, properties }.
	actionHandlers: {
		// ── LOAD_ATTACHMENTS ──────────────────────────────────────────────────
		// Fetches the current list of attachments from the ServiceNow API and
		// populates state.previews. Called on initial load and after deletes.
		// Also called by the view when properties aren't ready on the first render.
		LOAD_ATTACHMENTS: ({ updateState, properties }) => {
			console.log("LOAD_ATTACHMENTS triggered");
			const { recordId, tableName } = resolveProperties(properties);
			if (!recordId || !tableName) return; // properties not ready — bail

			updateState({ loading: true });
			fetchAttachments(tableName, recordId)
				.then((records) => {
					const previews = records.map((att) => ({
						localId: att.sys_id,
						sys_id: att.sys_id,
						storedName: att.file_name,
						name: decodeFileName(att.file_name),
						sizeBytes: Number(att.size_bytes),
						fileType: getFileType(decodeFileName(att.file_name)),
						status: "done",
						progress: 100,
						uploadedOn: att.sys_created_on || null,
					}));
					updateState({ previews, loading: false });
				})
				.catch((err) => {
					console.error("Fetch attachments failed:", err);
					updateState({ previews: [], loading: false });
					toastError(
						updateState,
						friendlyErrorMessage(err, "Failed to load attachments"),
					);
				});
		},

		// ── PROCESS_FILES ─────────────────────────────────────────────────────
		// Entry point for all uploads. Dispatched when the user picks or drops files.
		//
		// FLOW:
		//   1. Parse allowed extensions from the property
		//   2. Reject files with disallowed extensions  (error toast)
		//   3. Reject duplicate filenames               (error toast)
		//   4. Add valid files to previews as "uploading" (optimistic UI update)
		//   5. Upload each valid file in parallel
		//   6. Per file: success toast on success, error toast + "error" status on failure
		//   7. Once all uploads settle: refresh the list from the server
		PROCESS_FILES: ({ action, state, updateState, properties }) => {
			console.log("PROCESS_FILES triggered");
			const { files } = action.payload;

			// Step 1: Build expanded allowed extension list from the property string
			const allowedExts = parseAllowedExtensions(
				resolveProperties(properties).extensions,
			);

			// Step 2: Extension check — split files into allowed vs blocked
			const { valid: extValid, rejected: rejectedFiles } =
				partitionFilesByExtension(files, allowedExts);

			if (rejectedFiles.length) {
				const rejectedNames = rejectedFiles
					.map((f) => `"${f.name}"`)
					.join(", ");
				const allowedLabel =
					displayExtensionTokens(resolveProperties(properties).extensions) ||
					"none configured";
				toastError(
					updateState,
					`${rejectedFiles.length === 1 ? "File" : "Files"} ${rejectedNames} ${rejectedFiles.length === 1 ? "is" : "are"} not allowed. Accepted types: ${allowedLabel}.`,
				);
			}

			// Step 3: Duplicate check — split allowed files into new vs already attached
			const { unique: validFiles, duplicates: duplicateFiles } =
				partitionFilesByDuplicate(extValid, state.previews, allowedExts);

			if (duplicateFiles.length) {
				const dupNames = duplicateFiles.map((f) => `"${f.name}"`).join(", ");
				toastError(
					updateState,
					`${duplicateFiles.length === 1 ? "File" : "Files"} ${dupNames} ${duplicateFiles.length === 1 ? "is" : "are"} already attached. Duplicate files are not allowed.`,
				);
			}

			if (!validFiles.length) return; // nothing to upload

			// Step 4: Add optimistic "uploading" cards to the UI immediately
			// These give instant visual feedback before the API responds
			const newEntries = validFiles.map((file) => ({
				localId:
					"local_" + Date.now() + "_" + Math.random().toString(36).slice(2),
				sys_id: null, // null until confirmed saved on the server
				name: file.name,
				sizeBytes: file.size,
				fileType: getFileType(file.name),
				status: "uploading",
				progress: 50,
				uploadedOn: null,
				_file: file, // keep the File reference for the upload call
			}));

			const currentPreviews = [...state.previews, ...newEntries];
			updateState({ previews: currentPreviews });

			// Steps 5–7: Upload all files in parallel
			// Track how many are still in flight so we know when all are done
			let remaining = newEntries.length;

			newEntries.forEach((entry) => {
				const file = entry._file;
				const { tableName, recordId } = resolveProperties(properties);

				uploadToSysAttachment(file, tableName, recordId, allowedExts)
					.then(() => {
						// Step 6 (success): show per-file toast
						toastSuccess(updateState, `"${file.name}" uploaded successfully.`);
						remaining -= 1;

						// Step 7: when the last upload finishes, refresh from server
						// This replaces optimistic entries with real sys_ids and server metadata
						if (remaining === 0) {
							fetchAttachments(tableName, recordId)
								.then((records) => {
									const previews = records.map((att) => ({
										localId: att.sys_id,
										sys_id: att.sys_id,
										storedName: att.file_name,
										name: decodeFileName(att.file_name),
										sizeBytes: Number(att.size_bytes),
										fileType: getFileType(decodeFileName(att.file_name)),
										status: "done",
										progress: 100,
										uploadedOn: att.sys_created_on || null,
									}));
									updateState({ previews, loading: false });
								})
								.catch(() => {
									toastError(
										updateState,
										"Upload succeeded but the list could not be refreshed. Please reload the page.",
									);
								});
						}
					})
					.catch((err) => {
						// Step 6 (failure): show per-file error toast and mark card as failed
						console.error("Upload failed:", err);
						remaining -= 1;

						toastError(
							updateState,
							friendlyErrorMessage(err, `Failed to upload "${file.name}"`),
						);

						// Update just this card's status to "error"
						const idx = currentPreviews.findIndex(
							(p) => p.localId === entry.localId,
						);
						if (idx !== -1) {
							currentPreviews[idx] = {
								...currentPreviews[idx],
								status: "error",
								progress: 0,
							};
						}
						updateState({ previews: [...currentPreviews] });

						// Step 7: still refresh once all uploads have settled
						if (remaining === 0) {
							fetchAttachments(tableName, recordId)
								.then((records) => {
									const previews = records.map((att) => ({
										localId: att.sys_id,
										sys_id: att.sys_id,
										storedName: att.file_name,
										name: decodeFileName(att.file_name),
										sizeBytes: Number(att.size_bytes),
										fileType: getFileType(decodeFileName(att.file_name)),
										status: "done",
										progress: 100,
										uploadedOn: att.sys_created_on || null,
									}));
									updateState({ previews, loading: false });
								})
								.catch(() => {});
						}
					});
			});
		},

		// ── DELETE_FILE ───────────────────────────────────────────────────────
		// Triggered by the trash icon on an attachment card.
		// Shows a confirmation dialog, then removes the card optimistically
		// from the UI before calling the delete API.
		DELETE_FILE: ({ action, state, updateState }) => {
			console.log("DELETE_FILE triggered");
			const { file, index } = action.payload;
			if (!confirm("Are you sure you want to delete this attachment?")) return;

			// Optimistic removal — remove from UI immediately for snappy feedback
			const newPreviews = [...state.previews];
			newPreviews.splice(index, 1);
			updateState({ previews: newPreviews });

			if (file.sys_id) {
				deleteAttachment(file.sys_id)
					.then(() => {
						toastSuccess(updateState, `"${file.name}" deleted successfully.`);
					})
					.catch((err) => {
						console.error("Delete failed:", err);
						toastError(
							updateState,
							friendlyErrorMessage(err, `Failed to delete "${file.name}"`),
						);
					});
			}
		},

		// ── DOWNLOAD_FILE ─────────────────────────────────────────────────────
		// Triggered by the download icon on an attachment card.
		// Fetches the raw binary from the API and triggers a browser save dialog.
		// DOLI-encoded filenames are decoded back to the original before download.
		DOWNLOAD_FILE: ({ action, updateState }) => {
			console.log("DOWNLOAD_FILE triggered");
			const { file } = action.payload;
			if (!file.sys_id) return; // file not yet saved to server

			downloadAttachment(file.sys_id, file.storedName || file.name).catch(
				(err) => {
					console.error("Download failed:", err);
					toastError(
						updateState,
						friendlyErrorMessage(err, `Failed to download "${file.name}"`),
					);
				},
			);
		},

		// ── REFRESH_ATTACHMENTS ───────────────────────────────────────────────
		// Utility action to manually trigger a full reload of the attachment list.
		// Delegates to LOAD_ATTACHMENTS. Available for external integrations.
		REFRESH_ATTACHMENTS: ({ dispatch }) => {
			console.log("REFRESH_ATTACHMENTS triggered");
			dispatch("LOAD_ATTACHMENTS", {});
		},
	},
});
