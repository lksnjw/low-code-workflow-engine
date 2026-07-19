import Card from "../shared/ui/Card";
import Progress from "../shared/ui/Progress";

function SystemHealth({ services = [] }) {
  return (
    <Card>
      <h2 className="section-title">System Health</h2>
      <p className="section-subtitle mt-1">Runtime readiness across critical services.</p>
      <div className="mt-5 space-y-5">
        {services.length === 0 ? <p className="text-sm text-gray-500">No health data available.</p> : null}
        {services.map((service) => (
          <div key={service.name}>
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="font-semibold text-gray-800 dark:text-gray-100">
                {service.name}
              </span>
              <span className="text-gray-500 dark:text-gray-400">{service.meta}</span>
            </div>
            <Progress value={service.value} />
          </div>
        ))}
      </div>
    </Card>
  );
}

export default SystemHealth;
