import { createCustomElement } from "@servicenow/ui-core";
import snabbdom from "@servicenow/ui-renderer-snabbdom";
import styles from "./styles.scss";
import "@servicenow/now-button";
import "@servicenow/now-icon";

// ── Default extensions always allowed regardless of the extensions property ───
const DEFAULT_EXTENSIONS = [
	"klarf",
	"stif",
	...Array.from({ length: 1000 }, (_, i) => String(i).padStart(3, "0")),
];

function getToken() {
	return (
		window.g_ck ||
		document.cookie.match(/glide_user_activity=([^;]+)/)?.[1] ||
		""
	);
}

function snFetch(url, options = {}) {
	return fetch(url, {
		credentials: "same-origin",
		...options,
		headers: {
			"X-UserToken": getToken(),
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

function isDefaultExtension(ext) {
	return DEFAULT_EXTENSIONS.includes(ext.toLowerCase());
}

function encodeFileName(file) {
	const ext = file.name.split(".").pop().toLowerCase();
	if (!isDefaultExtension(ext)) return file.name;
	const baseName = file.name.substring(0, file.name.lastIndexOf("."));
	return `${baseName}#$${ext}.DOLI`;
}

function decodeFileName(storedName) {
	const match = storedName.match(/^(.+)#\$([^.]+)\.DOLI$/i);
	if (match) return `${match[1]}.${match[2]}`;
	return storedName;
}

// ── Friendly error message parser ─────────────────────────────────────────────
function friendlyErrorMessage(err, context) {
	const raw = err && err.message ? err.message : String(err || "");
	const jsonMatch = raw.match(/^\d+:\s*(\{.*\})$/s);
	if (jsonMatch) {
		try {
			const parsed = JSON.parse(jsonMatch[1]);
			const status = parsed.error && parsed.error.message;
			const detail = parsed.error && parsed.error.detail;
			const statusCode = raw.match(/^(\d+):/)?.[1];
			if (status) {
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
				return `${context}: ${status}${detail ? ` (${detail})` : ""}`;
			}
			if (statusCode === "401" || statusCode === "403")
				return `${context}: You do not have permission to perform this action.`;
			if (statusCode === "404")
				return `${context}: The requested resource was not found.`;
			if (statusCode === "500")
				return `${context}: A server error occurred. Please try again later.`;
		} catch (_) {}
	}
	if (/failed to fetch|networkerror|network request failed/i.test(raw))
		return `${context}: A network error occurred. Please check your connection and try again.`;
	return `${context}: Something went wrong. Please try again or contact your administrator.`;
}

// ── Toast helpers ─────────────────────────────────────────────────────────────
// Each toast: { id, type: 'success'|'error', text }
// Toasts auto-dismiss after 15 seconds.
// We manage the toasts array in a module-level variable because
// ServiceNow's updateState does not support functional updates (prev => ...).
let _toasts = [];
let _toastTimers = {};

function dismissToast(updateState, id) {
	clearTimeout(_toastTimers[id]);
	delete _toastTimers[id];
	_toasts = _toasts.filter((t) => t.id !== id);
	updateState({ toasts: [..._toasts] });
}

function addToast(updateState, type, text) {
	const id = Date.now() + "_" + Math.random().toString(36).slice(2);
	const toast = { id, type, text };
	_toasts = [..._toasts, toast];
	updateState({ toasts: [..._toasts] });
	_toastTimers[id] = setTimeout(() => dismissToast(updateState, id), 15000);
}

function toastSuccess(updateState, text) {
	addToast(updateState, "success", text);
}

function toastError(updateState, text) {
	addToast(updateState, "error", text);
}

function uploadToSysAttachment(file, tableName, tableSysId) {
	const uploadName = encodeFileName(file);
	const ext = file.name.split(".").pop().toLowerCase();

	const prepareFile = isDefaultExtension(ext)
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

function downloadAttachment(sysId, storedFileName) {
	const downloadName = decodeFileName(storedFileName);
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
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = downloadName;
			a.click();
			URL.revokeObjectURL(url);
		});
}

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

function formatSize(bytes) {
	const b = Number(bytes) || 0;
	if (b < 1024) return `${b} B`;
	if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
	return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

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

function parseAllowedExtensions(extensionsProp) {
	const userExts =
		!extensionsProp ||
		typeof extensionsProp !== "string" ||
		!extensionsProp.trim()
			? []
			: extensionsProp
					.split(/[\s,]+/)
					.map((e) => e.replace(/^\./, "").toLowerCase())
					.filter(Boolean);
	return [...new Set([...DEFAULT_EXTENSIONS, ...userExts])];
}

function partitionFilesByExtension(files, allowedExts) {
	const valid = [],
		rejected = [];
	files.forEach((file) => {
		const ext = file.name.split(".").pop().toLowerCase();
		(allowedExts.includes(ext) ? valid : rejected).push(file);
	});
	return { valid, rejected };
}

function partitionFilesByDuplicate(files, existingPreviews) {
	const existingNames = new Set(
		existingPreviews.map((p) => (p.storedName || p.name).toLowerCase()),
	);
	const unique = [],
		duplicates = [];
	files.forEach((file) => {
		const encodedName = encodeFileName(file).toLowerCase();
		(existingNames.has(encodedName) ? duplicates : unique).push(file);
	});
	return { unique, duplicates };
}

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

function resolveProperties(properties) {
	const el = document.querySelector("x-1621019-doli-custom-attachment");
	return {
		recordId:
			(properties && properties.recordId) ||
			(el && (el.getAttribute("record-id") || el.getAttribute("recordid"))) ||
			"",
		tableName:
			(properties && properties.tableName) ||
			(el && (el.getAttribute("table-name") || el.getAttribute("tablename"))) ||
			"",
	};
}

const view = (state, { updateState, dispatch, properties }) => {
	if (!state.initialized && !state.loading) {
		const { recordId, tableName } = resolveProperties(state.properties);
		if (recordId && tableName) {
			updateState({ initialized: true, loading: true });
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
		} else {
			setTimeout(() => updateState({ _tick: Date.now() }), 300);
			dispatch("LOAD_ATTACHMENTS", {});
		}
	}

	const readOnlyProp = state.properties && state.properties.readOnly;
	const isReadOnly =
		readOnlyProp === true ||
		(typeof readOnlyProp === "string" && readOnlyProp.toLowerCase() === "true");

	const userExts =
		properties &&
		typeof properties.extensions === "string" &&
		properties.extensions.trim()
			? properties.extensions
					.split(/[\s,]+/)
					.map((e) => e.replace(/^\./, "").toUpperCase())
					.filter(Boolean)
			: [];
	const hintText = userExts.length
		? `Allowed: KLARF, STIF, ${userExts.join(", ")}`
		: "Default Allowed: KLARF, STIF";

	const handlePickerClick = () => {
		if (isReadOnly) return;
		openNativeFilePicker((files) => dispatch("PROCESS_FILES", { files }));
	};

	const handleDrop = (e) => {
		e.preventDefault();
		if (isReadOnly) return;
		updateState({ isDragging: false });
		const files = Array.from(e.dataTransfer.files);
		if (files.length) dispatch("PROCESS_FILES", { files });
	};

	const toasts = state.toasts || [];

	return (
		<div className="attachment-widget">
			<div
				className={`upload-zone ${state.isDragging ? "upload-zone--dragging" : ""} ${isReadOnly ? "upload-zone--readonly" : ""}`}
				on-click={handlePickerClick}
				on-drop={handleDrop}
				on-dragover={(e) => {
					e.preventDefault();
					updateState({ isDragging: true });
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

			{/* Toast notification stack */}
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
											Uploading…
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
					<span>Loading attachments…</span>
				</div>
			)}
		</div>
	);
};

createCustomElement("x-1621019-doli-custom-attachment", {
	renderer: { type: snabbdom },
	view,
	styles,

	properties: {
		recordId: { default: "" },
		tableName: { default: "" },
		readOnly: { default: "" },
		extensions: { default: "" },
	},

	initialState: {
		previews: [],
		isDragging: false,
		loading: false,
		toasts: [], // replaces errorMessage / successMessage
		initialized: false,
		_tick: 0,
		_polling: false,
	},

	actionHandlers: {
		LOAD_ATTACHMENTS: ({ updateState, properties, state }) => {
			console.log("LOAD_ATTACHMENTS triggered");
			const { recordId, tableName } = resolveProperties(properties);
			if (!recordId || !tableName) return;
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

		PROCESS_FILES: ({ action, state, updateState, properties }) => {
			console.log("PROCESS_FILES triggered");
			const { files } = action.payload;

			// ── Extension validation ──────────────────────────────────────────────
			const allowedExts = parseAllowedExtensions(properties.extensions);
			const { valid: extValid, rejected: rejectedFiles } =
				partitionFilesByExtension(files, allowedExts);

			if (rejectedFiles.length) {
				const rejectedNames = rejectedFiles
					.map((f) => `"${f.name}"`)
					.join(", ");
				const allowedLabel = allowedExts.map((e) => e.toUpperCase()).join(", ");
				let parts = allowedLabel.split(",");
				let filteredParts = parts.filter((part) => {
					let trimmed = part.trim();
					let number = parseInt(trimmed, 10);
					return !(trimmed.length === 3 && number >= 0 && number <= 999);
				});
				let allowedCleanedLabels = filteredParts
					.join(", ")
					.replace(/\s+,/g, ",");
				toastError(
					updateState,
					`${rejectedFiles.length === 1 ? "File" : "Files"} ${rejectedNames} ${rejectedFiles.length === 1 ? "is" : "are"} not allowed. Accepted types: ${allowedCleanedLabels}.`,
				);
			}

			// ── Duplicate validation ──────────────────────────────────────────────
			const { unique: validFiles, duplicates: duplicateFiles } =
				partitionFilesByDuplicate(extValid, state.previews);

			if (duplicateFiles.length) {
				const dupNames = duplicateFiles.map((f) => `"${f.name}"`).join(", ");
				toastError(
					updateState,
					`${duplicateFiles.length === 1 ? "File" : "Files"} ${dupNames} ${duplicateFiles.length === 1 ? "is" : "are"} already attached. Duplicate files are not allowed.`,
				);
			}

			if (!validFiles.length) return;

			const newEntries = validFiles.map((file) => ({
				localId:
					"local_" + Date.now() + "_" + Math.random().toString(36).slice(2),
				sys_id: null,
				name: file.name,
				sizeBytes: file.size,
				fileType: getFileType(file.name),
				status: "uploading",
				progress: 50,
				uploadedOn: null,
				_file: file,
			}));

			const currentPreviews = [...state.previews, ...newEntries];
			updateState({ previews: currentPreviews });

			// Track per-file results to show individual toasts
			let remaining = newEntries.length;

			newEntries.forEach((entry) => {
				const file = entry._file;

				uploadToSysAttachment(
					file,
					resolveProperties(properties).tableName,
					resolveProperties(properties).recordId,
				)
					.then(() => {
						// Show a success toast for this specific file
						toastSuccess(updateState, `"${file.name}" uploaded successfully.`);
						remaining -= 1;

						if (remaining === 0) {
							// Refresh list once all uploads finish
							fetchAttachments(
								resolveProperties(properties).tableName,
								resolveProperties(properties).recordId,
							)
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
						console.error("Upload failed:", err);
						remaining -= 1;

						// Show a failure toast for this specific file
						toastError(
							updateState,
							friendlyErrorMessage(err, `Failed to upload "${file.name}"`),
						);

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

						if (remaining === 0) {
							fetchAttachments(
								resolveProperties(properties).tableName,
								resolveProperties(properties).recordId,
							)
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

		DELETE_FILE: ({ action, state, updateState }) => {
			console.log("DELETE_FILE triggered");
			const { file, index } = action.payload;
			if (!confirm("Are you sure you want to delete this attachment?")) return;

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

		DOWNLOAD_FILE: ({ action, state, updateState }) => {
			console.log("DOWNLOAD_FILE triggered");
			const { file } = action.payload;
			if (!file.sys_id) return;

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

		REFRESH_ATTACHMENTS: ({ dispatch }) => {
			console.log("REFRESH_ATTACHMENTS triggered");
			dispatch("LOAD_ATTACHMENTS", {});
		},
	},
});
