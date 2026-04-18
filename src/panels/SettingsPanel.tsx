import { type FormEvent } from "react";
import type { BusinessProfile, PricingRule, Station, StationEditDraft, StationMode } from "../types";
import { currency, minuteToTimeLabel } from "../utils";
import { Modal } from "../components/Modal";
import { NumericInput } from "../components/NumericInput";

interface PricingDraft {
  stationId: string;
  label: string;
  startTime: string;
  endTime: string;
  hourlyRate: number;
}

export function SettingsPanel(props: {
  stations: Station[];
  pricingRules: PricingRule[];
  businessProfile: BusinessProfile;
  stationForm: Station;
  editStationDraft: StationEditDraft | null;
  pricingDraft: PricingDraft;
  businessDraft: BusinessProfile;
  canEditSettings: boolean;
  isManagerReadOnly: boolean;
  onStationFormChange: (next: Station) => void;
  onEditStationDraftChange: (next: StationEditDraft | null) => void;
  onPricingDraftChange: (next: PricingDraft) => void;
  onBusinessDraftChange: (next: BusinessProfile) => void;
  onUpsertStation: (event: FormEvent<HTMLFormElement>) => void;
  onBeginEditStation: (station: Station) => void;
  onSaveEditedStation: (event: FormEvent<HTMLFormElement>) => void;
  onDeleteStation: (stationId: string) => void;
  onAddPricingRule: (event: FormEvent<HTMLFormElement>) => void;
  onDeletePricingRule: (ruleId: string) => void;
  onSaveBusinessProfile: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const { stationForm, editStationDraft, pricingDraft, businessDraft, canEditSettings, isManagerReadOnly } = props;

  return (
    <>
      <section className="section-grid settings-layout">
        {isManagerReadOnly && (
          <div className="read-only-banner field-span-full">Manager view: read-only access on this page.</div>
        )}
        <div className="panel field-span-full">
          <div className="panel-header">
            <div><h2>Business Profile</h2><p>Receipt identity and customer-facing contact details.</p></div>
          </div>
          {canEditSettings ? (
            <form className="form-grid" onSubmit={props.onSaveBusinessProfile}>
              <label>
                <span>Business Name</span>
                <input value={businessDraft.name} onChange={(event) => props.onBusinessDraftChange({ ...businessDraft, name: event.target.value })} />
              </label>
              <label>
                <span>Logo Text</span>
                <input value={businessDraft.logoText} onChange={(event) => props.onBusinessDraftChange({ ...businessDraft, logoText: event.target.value })} />
              </label>
              <label className="field-span-full">
                <span>Address</span>
                <input value={businessDraft.address} onChange={(event) => props.onBusinessDraftChange({ ...businessDraft, address: event.target.value })} />
              </label>
              <label>
                <span>Primary Phone</span>
                <input value={businessDraft.primaryPhone} onChange={(event) => props.onBusinessDraftChange({ ...businessDraft, primaryPhone: event.target.value })} />
              </label>
              <label>
                <span>Secondary Phone</span>
                <input value={businessDraft.secondaryPhone ?? ""} onChange={(event) => props.onBusinessDraftChange({ ...businessDraft, secondaryPhone: event.target.value })} />
              </label>
              <label className="field-span-full">
                <span>Receipt Footer</span>
                <input value={businessDraft.receiptFooter} onChange={(event) => props.onBusinessDraftChange({ ...businessDraft, receiptFooter: event.target.value })} />
              </label>
              <button className="primary-button" type="submit">Save Business Details</button>
            </form>
          ) : (
            <div className="activity-list">
              <div className="activity-row"><strong>Business Name</strong><span className="muted">{props.businessProfile.name}</span></div>
              <div className="activity-row"><strong>Logo Text</strong><span className="muted">{props.businessProfile.logoText}</span></div>
              <div className="activity-row"><strong>Primary Phone</strong><span className="muted">{props.businessProfile.primaryPhone}</span></div>
              <div className="activity-row"><strong>Secondary Phone</strong><span className="muted">{props.businessProfile.secondaryPhone || "—"}</span></div>
              <div className="activity-row"><strong>Address</strong><span className="muted">{props.businessProfile.address}</span></div>
              <div className="activity-row"><strong>Receipt Footer</strong><span className="muted">{props.businessProfile.receiptFooter}</span></div>
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-header">
            <div>
              <h2>Stations</h2>
              <p>{canEditSettings ? "Add or remove tables, consoles, and other timed resources." : "Review configured stations and their current status."}</p>
            </div>
          </div>
          {canEditSettings && (
            <form className="form-grid" onSubmit={props.onUpsertStation}>
              <label>
                <span>Station Name</span>
                <input required value={stationForm.name} onChange={(event) => props.onStationFormChange({ ...stationForm, name: event.target.value })} />
              </label>
              <label>
                <span>Mode</span>
                <select value={stationForm.mode} onChange={(event) => props.onStationFormChange({ ...stationForm, mode: event.target.value as StationMode })}>
                  <option value="timed">Timed</option>
                  <option value="unit_sale">Unit sale</option>
                </select>
              </label>
              <label className="checkbox-field">
                <input type="checkbox" checked={stationForm.active} onChange={(event) => props.onStationFormChange({ ...stationForm, active: event.target.checked })} />
                <span>Active station</span>
              </label>
              <label className="checkbox-field">
                <input type="checkbox" checked={stationForm.ltpEnabled} onChange={(event) => props.onStationFormChange({ ...stationForm, ltpEnabled: event.target.checked })} />
                <span>LTP enabled</span>
              </label>
              <button className="primary-button" type="submit">Create Station</button>
            </form>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Station</th><th>Mode</th><th>LTP</th><th>Status</th>{canEditSettings && <th />}</tr>
              </thead>
              <tbody>
                {props.stations.map((station) => (
                  <tr key={station.id}>
                    <td>{station.name}</td>
                    <td>{station.mode}</td>
                    <td>{station.ltpEnabled ? "Enabled" : "Off"}</td>
                    <td>{station.active ? "Active" : "Inactive"}</td>
                    {canEditSettings && (
                      <td>
                        <div className="button-row dense">
                          <button className="ghost-button" type="button" onClick={() => props.onBeginEditStation(station)}>Edit</button>
                          <button className="ghost-button danger" type="button" onClick={() => props.onDeleteStation(station.id)}>Delete</button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div>
              <h2>Pricing Bands</h2>
              <p>{canEditSettings ? "Hourly rates are prorated and split across time ranges automatically." : "Review configured rate bands for each station."}</p>
            </div>
          </div>
          {canEditSettings && (
            <form className="form-grid" onSubmit={props.onAddPricingRule}>
              <label>
                <span>Station</span>
                <select value={pricingDraft.stationId} onChange={(event) => props.onPricingDraftChange({ ...pricingDraft, stationId: event.target.value })}>
                  <option value="">Select station</option>
                  {props.stations.map((station) => <option key={station.id} value={station.id}>{station.name}</option>)}
                </select>
              </label>
              <label>
                <span>Label</span>
                <input required value={pricingDraft.label} onChange={(event) => props.onPricingDraftChange({ ...pricingDraft, label: event.target.value })} placeholder="Day, Night..." />
              </label>
              <label>
                <span>Start</span>
                <input type="time" value={pricingDraft.startTime} onChange={(event) => props.onPricingDraftChange({ ...pricingDraft, startTime: event.target.value })} />
              </label>
              <label>
                <span>End</span>
                <input type="time" value={pricingDraft.endTime} onChange={(event) => props.onPricingDraftChange({ ...pricingDraft, endTime: event.target.value })} />
              </label>
              <label>
                <span>Hourly Rate</span>
                <NumericInput required mode="decimal" min={0} value={pricingDraft.hourlyRate} onValueChange={(value) => props.onPricingDraftChange({ ...pricingDraft, hourlyRate: value })} />
              </label>
              <button className="primary-button" type="submit">Add Pricing Rule</button>
            </form>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Station</th><th>Label</th><th>Time Band</th><th>Rate</th>{canEditSettings && <th />}</tr>
              </thead>
              <tbody>
                {props.pricingRules.map((rule) => (
                  <tr key={rule.id}>
                    <td>{props.stations.find((station) => station.id === rule.stationId)?.name || "Station"}</td>
                    <td>{rule.label}</td>
                    <td>{minuteToTimeLabel(rule.startMinute)} - {minuteToTimeLabel(rule.endMinute)}</td>
                    <td>{currency(rule.hourlyRate)}/hr</td>
                    {canEditSettings && (
                      <td><button className="ghost-button danger" type="button" onClick={() => props.onDeletePricingRule(rule.id)}>Delete</button></td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {editStationDraft && (
        <Modal
          title={`Edit Station${editStationDraft.name ? ` - ${editStationDraft.name}` : ""}`}
          onClose={() => props.onEditStationDraftChange(null)}
        >
          <form className="form-grid" onSubmit={props.onSaveEditedStation}>
            <label>
              <span>Station Name</span>
              <input
                required
                value={editStationDraft.name}
                onChange={(event) =>
                  props.onEditStationDraftChange({ ...editStationDraft, name: event.target.value })
                }
              />
            </label>
            <label>
              <span>Mode</span>
              <select
                value={editStationDraft.mode}
                onChange={(event) =>
                  props.onEditStationDraftChange({ ...editStationDraft, mode: event.target.value as StationMode })
                }
              >
                <option value="timed">Timed</option>
                <option value="unit_sale">Unit sale</option>
              </select>
            </label>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={editStationDraft.active}
                onChange={(event) =>
                  props.onEditStationDraftChange({ ...editStationDraft, active: event.target.checked })
                }
              />
              <span>Active station</span>
            </label>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={editStationDraft.ltpEnabled}
                onChange={(event) =>
                  props.onEditStationDraftChange({ ...editStationDraft, ltpEnabled: event.target.checked })
                }
              />
              <span>LTP enabled</span>
            </label>
            <div className="button-row field-span-full">
              <button className="secondary-button" type="button" onClick={() => props.onEditStationDraftChange(null)}>
                Cancel
              </button>
              <button className="primary-button" type="submit">
                Update Station
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
