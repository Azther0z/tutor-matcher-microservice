import type { Metadata } from "next";
import { TermsCopy } from "@/components/legal-copy";

export const metadata: Metadata = { title: "Terms of Service" };

export default function TermsPage() {
  return <><header className="section-heading"><p className="eyebrow">LEGAL</p><h1>Terms of Service</h1><p>These terms describe the Tutor Matcher course demonstration.</p></header><section className="panel legal-copy"><TermsCopy /></section></>;
}
