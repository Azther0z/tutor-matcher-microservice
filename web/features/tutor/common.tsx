"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  ApiError,
  apiResponse,
  errorMessage,
  fieldErrors,
  type ApiOptions,
} from "@/lib/api";
import { Notice } from "@/components/field";
import type { Operation, Pagination } from "./types";

export const revisionTag = (revision: string) => `"${revision}"`;
export const bangkokTime = (timestamp: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
export const bangkokDate = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

export function useResource<T>(path: string | null, auth = true) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [error, setError] = useState("");
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    if (!path) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const result = await api<T>(path, { auth });
      if (generation.current === current) setData(result);
    } catch (e) {
      if (generation.current === current) {
        setData(null);
        setError(
          errorMessage(e, "This information is unavailable. Please retry."),
        );
      }
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }, [path, auth]);
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  return { data, loading, error, reload: load };
}

type SavedAction = { path: string; options: ApiOptions; signature: string };
export function useAction(onSuccess?: () => void | Promise<void>) {
  const saved = useRef<SavedAction | null>(null);
  const lock = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [operation, setOperation] = useState<Operation | null>(null);
  const invoke = async <T,>(action: SavedAction): Promise<T | null> => {
    if (lock.current) return null;
    lock.current = true;
    setPending(true);
    setError("");
    setErrors({});
    setNotice("");
    try {
      const { data } = await apiResponse<T>(action.path, action.options);
      saved.current = null;
      setUncertain(false);
      const result = data as T & Partial<Operation>;
      if (
        result &&
        result.status === "PENDING" &&
        typeof result.statusUrl === "string"
      ) {
        setOperation(result as Operation);
        setNotice(
          "Your action was accepted and is still processing. Refresh its status before repeating it.",
        );
      } else {
        setOperation(null);
        setNotice("Saved.");
      }
      await onSuccess?.();
      return data;
    } catch (e) {
      setErrors(fieldErrors(e));
      setError(
        errorMessage(
          e,
          "We could not confirm the result. Retry the original action below.",
        ),
      );
      const unresolved =
        !(e instanceof ApiError) ||
        e.status >= 500 ||
        e.status === 408 ||
        e.status === 429;
      setUncertain(unresolved);
      if (!unresolved) saved.current = null;
      return null;
    } finally {
      lock.current = false;
      setPending(false);
    }
  };
  const run = async <T,>(
    path: string,
    body?: unknown,
    method = "POST",
    revision?: string,
  ): Promise<T | null> => {
    const signature = JSON.stringify({ path, body, method, revision });
    if (operation?.status === "PENDING") {
      setError(
        "The accepted action is still processing. Check its status first.",
      );
      return null;
    }
    if (saved.current && saved.current.signature !== signature) {
      setError(
        "A previous result is uncertain. Retry the original action before changing it.",
      );
      return null;
    }
    if (!saved.current)
      saved.current = {
        path,
        signature,
        options: {
          method,
          body,
          idempotencyKey: crypto.randomUUID(),
          ...(revision === undefined ? {} : { ifMatch: revisionTag(revision) }),
        },
      };
    return invoke<T>(saved.current);
  };
  const retry = () =>
    saved.current ? invoke(saved.current) : Promise.resolve(null);
  const poll = async () => {
    if (!operation) return;
    setPending(true);
    setError("");
    try {
      const next = await api<Operation>(
        operation.statusUrl.replace(/^\/api(?=\/)/, ""),
      );
      setOperation(next);
      if (next.status !== "PENDING") {
        setNotice(
          next.status === "SUCCEEDED"
            ? "Processing finished."
            : "The action was rejected. Refresh the page to review the current state.",
        );
        await onSuccess?.();
      }
    } catch (e) {
      setError(
        errorMessage(
          e,
          "Could not check processing status. Retry the status check.",
        ),
      );
    } finally {
      setPending(false);
    }
  };
  return {
    run,
    retry,
    poll,
    pending,
    error,
    errors,
    notice,
    uncertain,
    operation,
  };
}
export type ActionState = ReturnType<typeof useAction>;
export function ActionMessages({ action }: { action: ActionState }) {
  return (
    <>
      {action.error && <Notice kind="error">{action.error}</Notice>}
      {Object.keys(action.errors).length > 0 && (
        <ul role="alert">
          {Object.entries(action.errors).map(([key, value]) => (
            <li key={key}>
              {key}: {value}
            </li>
          ))}
        </ul>
      )}
      {action.notice && <Notice kind="success">{action.notice}</Notice>}
      {action.uncertain && (
        <button
          className="button"
          disabled={action.pending}
          onClick={() => void action.retry()}
        >
          Retry original action
        </button>
      )}
      {action.operation?.status === "PENDING" && (
        <p role="status">
          Processing: {action.operation.id}{" "}
          <button
            className="button button-quiet"
            disabled={action.pending}
            onClick={() => void action.poll()}
          >
            Check processing status
          </button>
        </p>
      )}
    </>
  );
}
export function ResourceState({
  loading,
  error,
  retry,
}: {
  loading: boolean;
  error: string;
  retry: () => void;
}) {
  if (loading) return <p role="status">Loading...</p>;
  if (error)
    return (
      <>
        <Notice kind="error">{error}</Notice>
        <button className="button" onClick={retry}>
          Try again
        </button>
      </>
    );
  return null;
}
export function Pager({
  pagination,
  onPage,
}: {
  pagination: Pagination;
  onPage: (page: number) => void;
}) {
  return (
    <nav aria-label="Results pages" className="pagination">
      <button
        className="button button-quiet"
        disabled={pagination.page <= 1}
        onClick={() => onPage(pagination.page - 1)}
      >
        Previous
      </button>
      <span>
        {pagination.totalItems} results. Page {pagination.page} of{" "}
        {Math.max(1, pagination.totalPages)}
      </span>
      <button
        className="button button-quiet"
        disabled={pagination.page >= pagination.totalPages}
        onClick={() => onPage(pagination.page + 1)}
      >
        Next
      </button>
    </nav>
  );
}
export function TutorNavigation() {
  return (
    <nav className="button-row" aria-label="Tutor workspace">
      <Link className="text-link" href="/teach/application">
        Application and history
      </Link>
      <Link className="text-link" href="/teach/profile">
        Profile and publication
      </Link>
      <Link className="text-link" href="/teach/subjects">
        Subjects
      </Link>
      <Link className="text-link" href="/teach/availability">
        Availability
      </Link>
      <Link className="text-link" href="/discover">
        Find a tutor
      </Link>
    </nav>
  );
}
