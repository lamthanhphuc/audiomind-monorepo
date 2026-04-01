const bars = [0.12, 0.65, 0.48, 0.32, 0.58, 0.45, 0.26, 0.22, 0.72, 0.54]

export default function HeroChart() {
  return (
    <div className="hero-chart">
      <div className="hero-chart__bars">
        {bars.map((value, index) => (
          <span
            key={index}
            className="hero-chart__bar"
            style={{ height: `${value * 100}%` }}
          />
        ))}
      </div>
      <svg
        className="hero-chart__line"
        viewBox="0 0 100 40"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <polyline
          points="0,35 10,30 22,8 35,18 48,24 60,12 72,18 82,30 100,20"
          fill="none"
        />
        <circle cx="22" cy="8" r="1.6" />
        <circle cx="60" cy="12" r="1.6" />
        <circle cx="82" cy="30" r="1.6" />
      </svg>
    </div>
  )
}
