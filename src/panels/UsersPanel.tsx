import { type FormEvent } from "react";
import type { Role, TabId, User, UserEditDraft, UserPasswordDraft } from "../types";
import { Modal } from "../components/Modal";
import { tabsByRole, ALL_TABS } from "../constants";

interface UserForm {
  name: string;
  username: string;
  password: string;
  role: Role;
}

export function UsersPanel(props: {
  users: User[];
  userForm: UserForm;
  editUserDraft: UserEditDraft | null;
  passwordDraft: UserPasswordDraft | null;
  passwordError: string;
  onUserFormChange: (next: UserForm) => void;
  onEditUserDraftChange: (next: UserEditDraft | null) => void;
  onPasswordDraftChange: (next: UserPasswordDraft | null) => void;
  onCreateUser: (event: FormEvent<HTMLFormElement>) => void;
  onBeginEditUser: (user: User) => void;
  onSaveUserEdits: (event: FormEvent<HTMLFormElement>) => void;
  onOpenChangePassword: (user: User) => void;
  onSaveUserPassword: (event: FormEvent<HTMLFormElement>) => void;
  onToggleUserActive: (userId: string) => void;
}) {
  const { userForm, editUserDraft, passwordDraft, passwordError } = props;

  const passwordDraftUsername = props.users.find((u) => u.id === passwordDraft?.userId)?.username;

  return (
    <>
      <section className="section-grid">
        <div className="panel">
          <div className="panel-header">
            <div><h2>Create User</h2><p>Create accounts for admin, manager, and reception users.</p></div>
          </div>
          <form className="form-grid" onSubmit={props.onCreateUser}>
            <label>
              <span>Name</span>
              <input
                required
                value={userForm.name}
                onChange={(event) => props.onUserFormChange({ ...userForm, name: event.target.value })}
              />
            </label>
            <label>
              <span>Username</span>
              <input
                required
                value={userForm.username}
                onChange={(event) => props.onUserFormChange({ ...userForm, username: event.target.value })}
              />
            </label>
            <label>
              <span>Password</span>
              <input
                type="password"
                required
                value={userForm.password}
                onChange={(event) => props.onUserFormChange({ ...userForm, password: event.target.value })}
              />
            </label>
            <label>
              <span>Role</span>
              <select
                value={userForm.role}
                onChange={(event) => props.onUserFormChange({ ...userForm, role: event.target.value as Role })}
              >
                <option value="admin">Admin</option>
                <option value="manager">Manager</option>
                <option value="receptionist">Receptionist</option>
              </select>
            </label>
            <button className="primary-button" type="submit">Create User</button>
          </form>
        </div>
        <div className="panel">
          <div className="panel-header">
            <div><h2>Edit Users</h2><p>Only admins can edit user details, change passwords, or revoke access.</p></div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th /></tr>
              </thead>
              <tbody>
                {props.users.map((user) => (
                  <tr key={user.id}>
                    <td>{user.name}</td>
                    <td>{user.username}</td>
                    <td>{user.role}</td>
                    <td>{user.active ? "Active" : "Inactive"}</td>
                    <td>
                      <div className="button-row dense">
                        <button className="ghost-button" type="button" onClick={() => props.onBeginEditUser(user)}>Edit</button>
                        <button className="ghost-button" type="button" onClick={() => props.onOpenChangePassword(user)}>Change Password</button>
                        <button className="ghost-button" type="button" onClick={() => props.onToggleUserActive(user.id)}>
                          {user.active ? "Disable" : "Enable"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {editUserDraft && (
        <Modal title="Edit User" onClose={() => props.onEditUserDraftChange(null)}>
          <form className="form-grid" onSubmit={props.onSaveUserEdits}>
            <label>
              <span>Name</span>
              <input
                required
                value={editUserDraft.name}
                onChange={(event) =>
                  props.onEditUserDraftChange({ ...editUserDraft, name: event.target.value })
                }
              />
            </label>
            <label>
              <span>Username</span>
              <input
                required
                value={editUserDraft.username}
                onChange={(event) =>
                  props.onEditUserDraftChange({ ...editUserDraft, username: event.target.value })
                }
              />
            </label>
            <label className="field-span-full">
              <span>Role</span>
              <select
                value={editUserDraft.role}
                onChange={(event) =>
                  props.onEditUserDraftChange({ ...editUserDraft, role: event.target.value as Role, tabPermissions: undefined })
                }
              >
                <option value="admin">Admin</option>
                <option value="manager">Manager</option>
                <option value="receptionist">Receptionist</option>
              </select>
            </label>
            {(() => {
              const roleDefault = new Set(tabsByRole[editUserDraft.role].map((t) => t.id));
              const grantable = ALL_TABS.filter((t) => !roleDefault.has(t.id));
              if (grantable.length === 0) return null;
              const granted = new Set(editUserDraft.tabPermissions ?? []);
              function toggleTab(tabId: TabId) {
                const next = new Set(granted);
                if (next.has(tabId)) next.delete(tabId); else next.add(tabId);
                props.onEditUserDraftChange({ ...editUserDraft, tabPermissions: next.size > 0 ? [...next] : undefined });
              }
              return (
                <div className="field-span-full">
                  <span style={{ display: "block", marginBottom: "0.4rem", fontSize: "0.85rem", color: "#555" }}>
                    Extra tab access (beyond {editUserDraft.role} defaults)
                  </span>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                    {grantable.map((tab) => (
                      <label key={tab.id} className="checkbox-field" style={{ width: "auto" }}>
                        <input
                          type="checkbox"
                          checked={granted.has(tab.id)}
                          onChange={() => toggleTab(tab.id)}
                        />
                        <span>{tab.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })()}
            <div className="button-row field-span-full">
              <button className="secondary-button" type="button" onClick={() => props.onEditUserDraftChange(null)}>
                Cancel
              </button>
              <button className="primary-button" type="submit">
                Save User
              </button>
            </div>
          </form>
        </Modal>
      )}

      {passwordDraft && (
        <Modal
          title={`Change Password${passwordDraftUsername ? ` · ${passwordDraftUsername}` : ""}`}
          onClose={() => props.onPasswordDraftChange(null)}
        >
          <form className="form-grid" onSubmit={props.onSaveUserPassword}>
            <label className="field-span-full">
              <span>New Password</span>
              <input
                type="password"
                required
                value={passwordDraft.password}
                onChange={(event) =>
                  props.onPasswordDraftChange({ ...passwordDraft, password: event.target.value })
                }
              />
            </label>
            <label className="field-span-full">
              <span>Confirm Password</span>
              <input
                type="password"
                required
                value={passwordDraft.confirmPassword}
                onChange={(event) =>
                  props.onPasswordDraftChange({ ...passwordDraft, confirmPassword: event.target.value })
                }
              />
            </label>
            {passwordError && <div className="error-text field-span-full">{passwordError}</div>}
            <div className="button-row field-span-full">
              <button className="secondary-button" type="button" onClick={() => props.onPasswordDraftChange(null)}>
                Cancel
              </button>
              <button className="primary-button" type="submit">
                Update Password
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
