/** Counts describe permitted current SQL receipts, not physical vector points. */
export default function CollectionSummary({ catalog }) {
  if (!catalog?.collections) return null;
  return <section aria-label="Schema collection destinations" className="space-y-2">
    <h3 className="font-semibold">Collection destinations</h3>
    <p className="text-xs text-gray-500">Separated by source, entity and restricted access. Counts include only documents you may read; older vectors and other users&apos; private files are not counted.</p>
    <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr className="border-b border-gray-200 dark:border-gray-700"><th className="p-2">Source / entity</th><th className="p-2">Access</th><th className="p-2">What belongs here</th><th className="p-2">Searchable</th><th className="p-2">Collection</th></tr></thead>
      <tbody>{catalog.collections.map(route => <tr key={route.collection} className="border-b border-gray-100 align-top dark:border-gray-800"><td className="p-2">{route.source_system_id} / {route.source_entity}</td><td className="p-2">{route.tier === "restricted" ? "Restricted · owner only" : "Standard · sharing opt-in"}</td><td className="p-2">{route.document_types.join(", ") || "No new uploads under this schema revision"}<p className="mt-1 text-gray-500">{route.description}</p></td><td className="p-2">{route.searchable_documents}{Object.entries(route.document_type_counts ?? {}).map(([type, count]) => <p key={type} className="mt-1 text-gray-500">{type}: {count}</p>)}</td><td className="max-w-64 break-all p-2 font-mono">{route.collection}</td></tr>)}</tbody></table></div>
    <p className="text-[11px] text-gray-500">{catalog.counts_complete ? "Current permitted inventory" : "Bounded inventory, not a complete count"} · as of {new Date(catalog.as_of).toLocaleString()}. Collections are provisioned when first indexed; zero permitted documents does not mean the physical collection is absent.</p>
    {catalog.legacy_current_documents > 0 && <p className="text-xs text-amber-700 dark:text-amber-300">{catalog.legacy_current_documents} current document(s) remain in the previous private collection. They are still retrievable. An administrator can migrate their own documents without deleting old vectors.</p>}
  </section>;
}
