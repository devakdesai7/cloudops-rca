import { useParams } from 'react-router-dom'

/**
 * Placeholder — will be fully built in Tasks 3-5.
 * For now just surfaces the raw incidentId so navigation can be verified.
 */
export default function IncidentDetail() {
  const { incidentId } = useParams()

  return (
    <div style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
      <h2>Incident Detail</h2>
      <p>
        Incident ID: <code>{incidentId}</code>
      </p>
      <p style={{ color: '#57606a' }}>
        Full triage view coming in Tasks 3–5.
      </p>
    </div>
  )
}
