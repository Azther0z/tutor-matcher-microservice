"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { RequireAuth } from "@/lib/auth-context";
import { Field, Notice } from "@/components/field";
import { Dropdown } from "@/components/dropdown";
import { api, errorMessage } from "@/lib/api";
import type { AccountPage as AccountPageType } from "@/lib/types";

function statusClass(status: string) { return status === "ACTIVE" ? "badge" : status === "BANNED" ? "badge danger" : "badge warn"; }
function UserSearch() {
  const [q, setQ] = useState(""); const [capability, setCapability] = useState(""); const [page, setPage] = useState(1);
  const [result, setResult] = useState<AccountPageType | null>(null); const [pending, setPending] = useState(false); const [error, setError] = useState("");
  const load = useCallback(async (nextPage = 1) => {
    setPending(true); setError("");
    const params = new URLSearchParams({ page: String(nextPage), pageSize: "20" }); if (q.trim()) params.set("q", q.trim()); if (capability) params.set("capability", capability);
    try { setResult(await api<AccountPageType>(`/admin/users?${params}`)); setPage(nextPage); }
    catch (e) { setError(errorMessage(e, "Could not load accounts.")); }
    finally { setPending(false); }
  }, [q, capability]);
  useEffect(() => { void load(1); }, [load]);
  return <><header className="section-heading"><h1>Account access</h1><p>Search current accounts and review restriction history. Account actions require a reason and current revision.</p></header><section className="panel"><form className="inline-form" onSubmit={(e) => { e.preventDefault(); void load(1); }}><Field id="q" label="Search by name or email" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. Alex or alex@example.com"/><div className="field"><label htmlFor="capability">Capability</label><Dropdown id="capability" value={capability} onValueChange={setCapability} options={[{ value: "", label: "Any capability" }, { value: "STUDENT", label: "Student" }, { value: "TUTOR", label: "Tutor" }, { value: "ADMIN", label: "Admin" }]} /></div><button className="button" disabled={pending}>{pending ? "Searching…" : "Search"}</button></form>{error && <Notice kind="error">{error}</Notice>}{result && <><div className="stat-line" style={{ marginTop: 16 }}><span>{result.pagination.totalItems} accounts</span><span>Page {result.pagination.page} of {Math.max(1,result.pagination.totalPages)}</span></div><div className="table-wrap"><table className="data-table"><thead><tr><th>Name</th><th>Email</th><th>Capabilities</th><th>Status</th><th>Revision</th><th/></tr></thead><tbody>{result.items.map((item) => <tr key={item.id}><td>{item.firstName} {item.lastName}</td><td>{item.email}</td><td>{item.capabilities.join(", ")}</td><td><span className={statusClass(item.status)}>{item.status}</span></td><td>{item.revision}</td><td><Link href={`/admin/users/${encodeURIComponent(item.id)}`}>Review</Link></td></tr>)}</tbody></table>{result.items.length === 0 && <div className="empty-state">No accounts match this search.</div>}</div><div className="pagination"><span>Page {page}, {result.pagination.totalItems} results</span><div className="button-row"><button className="button button-quiet" disabled={pending || page <= 1} onClick={() => void load(page - 1)}>Previous</button><button className="button button-quiet" disabled={pending || page >= result.pagination.totalPages} onClick={() => void load(page + 1)}>Next</button></div></div></>}</section><p className="form-footer">Use <Link href="/demo/password-resets">synthetic reset delivery inspection</Link> for reset verification during demos.</p></>;
}
export default function AdminUsersPage() { return <RequireAuth admin><UserSearch/></RequireAuth>; }
