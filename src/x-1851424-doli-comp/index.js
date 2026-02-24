import { createCustomElement, actionTypes } from "@servicenow/ui-core";
import snabbdom from "@servicenow/ui-renderer-snabbdom";
import styles from "./styles.scss";

const { COMPONENT_PROPERTY_CHANGED } = actionTypes;
const WAFER_OPTIONS = [25, 50, 100];

let firstLoad = true; // Use a module-level variable for first load

const view = (state, { updateProperties }) => {
	const {
		mode = "standard",
		wafer = 0,
		selected = {},
		editablevalues = {},
		editingIndex = null,
		editingValue = "",
		operation = "create",
		readonly = false
	} = state;

	// console.log("Component State: ", state);
	const total = Number(wafer) === 0 ? 25 : Number(wafer);	
	

//   console.log('Auto-dispatch payload triggered:', { mode, wafer, selected, operation, readonly });


	// On first load, if operation is create, force wafer=25 and selected empty
	if (firstLoad && operation === "create") {
		updateProperties({
			wafer: 25,
			selected: {},
		});
		firstLoad = false;
		return null; // Wait for next render
	}

	const selectedObj = typeof selected === "object" && selected !== null ? selected : {};
	const selectedKeys = Object.keys(selectedObj).filter((key) => selectedObj[key]).map((k) => parseInt(k, 10));
	const allSelected = selectedKeys.length === total;

	const toggleSelection = (index) => {
		if (mode === "combine") return; // Ignore selection in combine mode
		const updated = { ...selectedObj };
		if (updated[index]) delete updated[index];
		else updated[index] = true;
		updateProperties({ selected: updated });
	};

	const handleEditChange = (index, value) => {
		// Allow only up to 3 digits or empty string
		if (/^\d{0,3}$/.test(value) || value === "") {
			updateProperties({ editingValue: value });
		}
	};

	const saveEdit = (index, value) => {
		// If the input is empty, treat as reset to original
		if (value === "" || value === null || value === undefined) {
			const updated = { ...editablevalues };
			delete updated[index];
			updateProperties({ editablevalues: updated, editingIndex: null, editingValue: "" });
			return;
		}

		let num = parseInt(value, 10);

		// If not a number or out of range, reset to original
		if (isNaN(num) || num < 1 || num > 100) {
			const updated = { ...editablevalues };
			delete updated[index];
			updateProperties({ editablevalues: updated, editingIndex: null, editingValue: "" });
			return;
		}

		const updated = { ...editablevalues };
		updated[index] = num;
		updateProperties({ editablevalues: updated, editingIndex: null, editingValue: "" });
	};

	const cancelEdit = () => {
		updateProperties({ editingIndex: null, editingValue: "" });
	};

	const toggleAll = () => {
		if (mode === "combine") return; // Ignore in combine mode
		let newSelected = {};
		if (selectedKeys.length === total) {
			newSelected = {};
		} else {
			for (let i = 1; i <= total; i++) newSelected[i] = true;
		}
		updateProperties({ selected: newSelected });
	};

	return (
		<div>
			<div className="wafer-list-container" aria-label="Wafer(s) List">
				<div className="header">
					<div className="title">
						<strong>Wafer(s) List *</strong>
					</div>
					<div className="count" title="Total wafers">
					{
						operation === "create" && mode !== 'combine' ? (
							<select
								id="mySelect"
								name="mySelect"
								value={`max_${wafer}`}
								disabled={readonly}
								on-change={(e) => {
									const val = parseInt(e.target.value.replace("max_", ""), 10);

									const filteredSelected = {};
									Object.keys(selectedObj).forEach((key) => {
										const numKey = parseInt(key, 10);
										if (numKey >= 1 && numKey <= val && selectedObj[key]) {
											filteredSelected[key] = true;
										}
									});

									const filterededitablevalues = {};
									Object.keys(editablevalues).forEach((key) => {
										const numKey = parseInt(key, 10);
										if (numKey >= 1 && numKey <= val) {
											filterededitablevalues[key] = editablevalues[key];
										}
									});

									updateProperties({
										wafer: val,
										selected: filteredSelected,
										editablevalues: filterededitablevalues,
										editingIndex: null,
										editingValue: ""
									});
								}}
							>
								<option value="max_25">25</option>
								<option value="max_50">50</option>
								<option value="max_100">100</option>
							</select>
						) : (
							<span style={{ fontWeight: "bold" }}>Wafer count: {total}</span>
						)
					}
					</div>
				</div>

				<div className="wafer-grid" role="list">
				{
					Array.from({ length: total }, (_, i) => {
						const index = i + 1;
						const isSelected = !!selectedObj[index];
						const isEdited = mode === "combine" && editablevalues[index] !== undefined;
						// In combine mode, only use isEdited for coloring
						const boxClass = mode === "combine"
							? `wafer-box${isEdited ? " pink" : ""}`
							: `wafer-box${isSelected ? " pink" : ""}`;
						const currentValue = editablevalues[index] !== undefined ? editablevalues[index] : index;
						const isEditing = editingIndex === index;

						return (
							<div
								className={boxClass}
								role="listitem"
								key={index}
								on-click={(e) => {
									e.stopPropagation();
									if (readonly) return;
									if (mode === "standard") {
										toggleSelection(index);
									} else if (mode === "combine") {
										updateProperties({
											editingIndex: index,
											editingValue:
												editablevalues[index] !== undefined
													? editablevalues[index]
													: index,
										});
									}
								}}
							>
							{	
								mode === "combine" && isEditing ? (
								<div>
									<input
										type="number"
										min={1}
										max={100}
										className="wafer-input"
										value={state.editingValue}
										maxLength="3"
										autoFocus
										disabled={readonly}
										on-click={(e) => e.stopPropagation()}
										on-blur={(e) => saveEdit(index, e.target.value)}
										on-keydown={(e) => {
											// Prevent '-', 'e', '+', and non-digits
											if (
												e.key === '-' ||
												e.key === 'e' ||
												e.key === '+' ||
												(e.key.length === 1 && !/[0-9]/.test(e.key) && !e.ctrlKey && !e.metaKey)
											) {
												e.preventDefault();
											}
											if (e.key === "Enter") {
												saveEdit(index, e.target.value);
											} else if (e.key === "Escape") {
												cancelEdit();
											}
										}}
										on-input={(e) => handleEditChange(index, e.target.value)}
									/>
									<span className="static-number visible">{index}</span>
								</div>
								) : (
								<div>
									<input
										type="number"
										min={1}
										max={100}
										className="wafer-input"
										readOnly
										style={{
											border: "none",
											color: "none",
											background: "none",
										}}
										value={currentValue}
										maxLength="3"
										autoFocus
									/>
									{
										mode ==="combine" && isEdited ? (<span className="static-number visible">{index}</span>):(null)
									}
								</div>
								)}
							</div>
						);
					})
				}
				</div>
				{
					// Only show "Select all" in non-combine mode
					mode !== "combine" && (
					<div
						className="select-toggle"
						role="button"
						tabIndex="0"
						aria-pressed={allSelected ? "true" : "false"}
						on-click={() => { if (!readonly) toggleAll(); }}
						style={readonly ? { pointerEvents: "none", opacity: 0.5 } : {}}
					>
						{allSelected ? "Unselect all" : "Select all"}
					</div> 	
					)
				}
				
			</div>
		</div>
	);
};


createCustomElement("x-1851424-doli-comp", {
	transformState(state) {
		const { properties } = state;
		let { selected } = properties;


		if (typeof selected === "string") {
			try {
				// Remove curly braces and quotes, split into numbers
				const clean = selected
					.replace(/[\{\}\"]/g, "")   // remove {, }, "
					.split(",")                 // split by comma
					.map(s => s.trim())         // trim spaces
					.filter(Boolean);           // remove empty strings

				// Convert to object format
				const selectedObj = {};
				clean.forEach(num => {
					const n = parseInt(num, 10);
					if (!isNaN(n)) selectedObj[n] = true;
				});
				properties.selected = selectedObj;
			} catch (e) {
				console.warn("⚠️ Could not parse selected property:", selected);
				properties.selected = {};
			}
		}

		return { ...properties };
	},
	renderer: { type: snabbdom },
	view,
	styles,
	properties: {
		mode: { default: "standard" },
		wafer: { default: 0 },
		selected: {
			default: {},
			observed: true,
			schema: {
				type: "object",
				additionalProperties: { type: "boolean" },
				label: "Selected Wafers",
				description: "Object with wafer numbers as keys and true as value",
			},
		},
		editablevalues: { default: "", observed: true },
		editingIndex: { default: null, observed: true },
		editingValue: { default: "", observed: true },
		operation: { default: "create" },
		readonly: { default: false },
	},
	
	// ✅ Dispatch once when component first mounts
	connectedCallback(coeffects) {
		const { dispatch, state } = coeffects;

		setTimeout(() => {
			const payload = { ...state.properties };
			console.log("📤 Initial payload dispatched:", payload);

			let selectedData = "";
			if (payload.mode === "combine") {
				const editableEntries = Object.entries(payload.editablevalues || {});
				selectedData = editableEntries
					.map(([key, val]) => `${key}:${val}`)
					.join(",");
			} else {
				selectedData = Object.keys(payload.selected || {})
					.filter(k => payload.selected[k])
					.join(",");
			}

			dispatch("SEND_COMP_DATA#VALUE_SET", {
				mode: payload.mode,
				wafer: payload.wafer,
				selected: selectedData,
				edited: payload.editablevalues,
				operation: payload.operation,
				readonly: payload.readonly
			});
		}, 0);
	},



	actionHandlers: {
		// ✅ Trigger when any property changes (from parent or UI Builder)
		[COMPONENT_PROPERTY_CHANGED]({ properties, dispatch }) {
			const payload = { ...properties };
			console.log("📤 Updated payload dispatched:", payload);

			let selectedData = "";
			if (payload.mode === "combine") {
				const editableEntries = Object.entries(payload.editablevalues || {});
				selectedData = editableEntries
					.map(([key, val]) => `${key}:${val}`)
					.join(",");
			} else {
				selectedData = Object.keys(payload.selected || {})
					.filter(k => payload.selected[k])
					.join(",");
			}

			dispatch("SEND_COMP_DATA#VALUE_SET", {
				mode: payload.mode,
				wafer: payload.wafer,
				selected: selectedData,
				edited: payload.editablevalues,
				operation: payload.operation,
				readonly: payload.readonly
			});
		}
	}
});