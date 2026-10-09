export function namedCustomerFixture(entityId: string, name: string, visitAt: string, continuation?: { sourceIds: string[]; customerId: string | undefined }) {
  if (!entityId.trim() || !name.trim() || !Number.isFinite(Date.parse(visitAt))) {
    throw new Error("Named QA fixtures require an entity identity, name and valid visit time.");
  }
  if (continuation && (!continuation.sourceIds.length || continuation.sourceIds.some(id => !id.trim())
    || !continuation.customerId?.trim())) throw new Error("Continuation fixtures require the source's canonical customer identity.");
  return { id: continuation?.customerId ?? `${entityId}-customer`, name: name.trim(), phone: "", visitAt };
}

interface FixtureReader {
  get(url: string, options: { headers: Record<string, string> }): Promise<{ status(): number; json(): Promise<unknown> }>;
}

/** Verify canonical persisted linkage, including server-side name matching; never repair after writing. */
export async function verifyNamedCustomerFixture(
  request: FixtureReader, identity: { restBase: string; headers: Record<string, string> },
  organizationId: string, rpc: string, command: unknown
) {
  if (rpc !== "start_session" && rpc !== "open_customer_tab") return;
  const payload = (command as { payload?: Record<string, unknown> })?.payload;
  const source = payload?.[rpc === "start_session" ? "session" : "tab"] as Record<string, unknown> | undefined;
  if (!source || typeof source.customerName !== "string" || !source.customerName.trim()) return;
  const customer = payload?.customer as Record<string, unknown> | undefined;
  if (typeof source.id !== "string" || !source.id.trim() || !customer || typeof customer.id !== "string" || !customer.id.trim()
    || customer.name !== source.customerName || customer.phone !== source.customerPhone) {
    throw new Error("Named fixture customer payload does not match its source.");
  }
  const read = async (table: string, query: Record<string, string>) => {
    const response = await request.get(`${identity.restBase}/${table}?${new URLSearchParams({ organization_id: `eq.${organizationId}`, ...query })}`, { headers: identity.headers });
    if (response.status() !== 200) throw new Error("Named fixture persistence read failed.");
    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length !== 1) throw new Error("Named fixture persistence identity is not unique.");
    return rows[0] as Record<string, unknown>;
  };
  const row = await read(rpc === "start_session" ? "sessions" : "customer_tabs", {
    id: `eq.${source.id}`, select: "id,organization_id,customer_id,customer_name,customer_phone,raw_data"
  });
  const raw = row.raw_data as Record<string, unknown> | undefined;
  if (Array.isArray(source.continuedFromSessionIds) && source.continuedFromSessionIds.length && row.customer_id !== customer.id) {
    throw new Error("Continuation fixture did not preserve the source customer identity.");
  }
  if (row.id !== source.id || row.organization_id !== organizationId || typeof row.customer_id !== "string" || !row.customer_id
    || row.customer_name !== source.customerName || (row.customer_phone ?? "") !== source.customerPhone
    || raw?.customerId !== row.customer_id || raw?.customerName !== source.customerName
    || (raw?.customerPhone ?? "") !== source.customerPhone) throw new Error("Named fixture source/customer linkage mismatch.");
  const profile = await read("customers", { id: `eq.${row.customer_id}`, select: "id,organization_id,name,phone" });
  if (profile.id !== row.customer_id || profile.organization_id !== organizationId || profile.name !== source.customerName
    || (profile.phone ?? "") !== source.customerPhone) throw new Error("Named fixture persisted customer mismatch.");
  return row.customer_id;
}
