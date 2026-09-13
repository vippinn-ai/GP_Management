import { describe, expect, it, vi } from "vitest";
import {
  classifyRemoteSessionProfileLookups,
  settleRemoteSessionProfileLookups,
  type RemoteOrganization,
  type RemoteProfile
} from "./backend";

const inactiveProfile: RemoteProfile = {
  id: "user-inactive",
  name: "Inactive User",
  username: "inactive",
  role: "receptionist",
  active: false
};

const activeProfile: RemoteProfile = { ...inactiveProfile, id: "user-active", username: "active", active: true };
const organization: RemoteOrganization = { id: "org-primary", name: "BreakPerfect", businessProfile: {} };

describe("remote session profile classification", () => {
  it("starts profile and organization lookups before either settles", async () => {
    let resolveProfile!: (value: { data: RemoteProfile; error: null }) => void;
    let resolveOrganization!: (value: { data: RemoteOrganization; error: null }) => void;
    const profilePromise = new Promise<{ data: RemoteProfile; error: null }>((resolve) => { resolveProfile = resolve; });
    const organizationPromise = new Promise<{ data: RemoteOrganization; error: null }>((resolve) => { resolveOrganization = resolve; });
    const loadProfile = vi.fn(() => profilePromise);
    const loadOrganization = vi.fn(() => organizationPromise);

    const resultPromise = settleRemoteSessionProfileLookups(activeProfile.id, true, loadProfile, loadOrganization);

    expect(loadProfile).toHaveBeenCalledTimes(1);
    expect(loadOrganization).toHaveBeenCalledTimes(1);
    resolveOrganization({ data: organization, error: null });
    resolveProfile({ data: activeProfile, error: null });
    await expect(resultPromise).resolves.toEqual({ status: "active", profile: activeProfile, organization });
  });

  it("does not start an organization lookup when it is not requested", async () => {
    const loadOrganization = vi.fn();
    await expect(settleRemoteSessionProfileLookups(
      activeProfile.id,
      false,
      async () => ({ data: activeProfile, error: null }),
      loadOrganization
    )).resolves.toEqual({ status: "active", profile: activeProfile });
    expect(loadOrganization).not.toHaveBeenCalled();
  });

  it("classifies a confirmed inactive profile before an organization timeout", () => {
    const result = classifyRemoteSessionProfileLookups(
      inactiveProfile.id,
      true,
      { status: "fulfilled", value: { data: inactiveProfile, error: null } },
      { status: "rejected", reason: new Error("organization timeout") }
    );

    expect(result).toEqual({ status: "inactive-or-missing", userId: inactiveProfile.id });
  });

  it("classifies a confirmed inactive profile before an organization response error", () => {
    const result = classifyRemoteSessionProfileLookups(
      inactiveProfile.id,
      true,
      { status: "fulfilled", value: { data: inactiveProfile, error: null } },
      { status: "fulfilled", value: { data: null, error: new Error("organization unavailable") } }
    );

    expect(result).toEqual({ status: "inactive-or-missing", userId: inactiveProfile.id });
  });

  it("classifies a confirmed missing profile before an organization timeout", () => {
    const result = classifyRemoteSessionProfileLookups(
      "user-missing",
      true,
      { status: "fulfilled", value: { data: null, error: null } },
      { status: "rejected", reason: new Error("organization timeout") }
    );

    expect(result).toEqual({ status: "inactive-or-missing", userId: "user-missing" });
  });

  it("fails closed when an active profile cannot load its required organization", () => {
    const result = classifyRemoteSessionProfileLookups(
      activeProfile.id,
      true,
      { status: "fulfilled", value: { data: activeProfile, error: null } },
      { status: "rejected", reason: new Error("organization timeout") }
    );

    expect(result).toMatchObject({
      status: "profile-unreachable",
      userId: activeProfile.id,
      error: expect.any(Error)
    });
  });

  it.each([
    { label: "response error", organizationResult: { status: "fulfilled", value: { data: null, error: new Error("organization error") } } },
    { label: "missing row", organizationResult: { status: "fulfilled", value: { data: null, error: null } } }
  ] as const)("fails closed for an active profile when the organization has a $label", ({ organizationResult }) => {
    const result = classifyRemoteSessionProfileLookups(
      activeProfile.id,
      true,
      { status: "fulfilled", value: { data: activeProfile, error: null } },
      organizationResult
    );
    expect(result).toMatchObject({ status: "profile-unreachable", userId: activeProfile.id, error: expect.any(Error) });
  });

  it.each([
    { label: "rejection", profileResult: { status: "rejected", reason: new Error("profile timeout") } },
    { label: "response error", profileResult: { status: "fulfilled", value: { data: null, error: new Error("profile error") } } }
  ] as const)("fails closed on a profile $label", ({ profileResult }) => {
    const result = classifyRemoteSessionProfileLookups(
      activeProfile.id,
      true,
      profileResult,
      { status: "fulfilled", value: { data: organization, error: null } }
    );
    expect(result).toMatchObject({ status: "profile-unreachable", userId: activeProfile.id, error: expect.any(Error) });
  });
});
