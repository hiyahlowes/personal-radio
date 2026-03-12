import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

export function WelcomePage() {
  const [name, setName] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    navigate(`/radio?name=${encodeURIComponent(trimmed)}`);
  };

  return (
    <div className="min-h-screen gradient-bg flex items-center justify-center px-4 relative overflow-hidden">
      {/* Background decorative elements */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-64 h-64 bg-purple-700/10 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-80 h-80 bg-violet-600/10 rounded-full blur-3xl" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-indigo-900/20 rounded-full blur-3xl" />
      </div>

      {/* Floating radio waves */}
      <div className="absolute inset-0 pointer-events-none flex items-center justify-center opacity-5">
        {[1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className="absolute border border-purple-400 rounded-full"
            style={{
              width: `${i * 120}px`,
              height: `${i * 120}px`,
              animationDelay: `${i * 0.4}s`,
              animation: 'pulse-ring 4s ease-out infinite',
            }}
          />
        ))}
      </div>

      <div className="relative z-10 text-center max-w-md w-full">
        {/* Logo / Icon */}
        <div className="fade-in-up flex items-center justify-center mb-8">
          <div className="relative float-animation">
            <div className="w-24 h-24 rounded-full bg-gradient-to-br from-violet-600 to-purple-800 flex items-center justify-center glow-purple">
              <svg className="w-12 h-12 text-white" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="12" cy="12" r="3" fill="currentColor" />
                <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2z" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 2" />
                <path d="M6.343 6.343A8 8 0 0 0 4 12a8 8 0 0 0 8 8 8 8 0 0 0 8-8 8 8 0 0 0-2.343-5.657" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <path d="M8.464 8.464A5 5 0 0 0 7 12a5 5 0 0 0 5 5 5 5 0 0 0 5-5 5 5 0 0 0-1.464-3.536" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </div>
            {/* Pulse ring */}
            <div className="absolute inset-0 rounded-full border-2 border-purple-500/40 animate-ping" />
          </div>
        </div>

        {/* Title */}
        <div className="fade-in-up-delay-1 mb-2">
          <span className="text-xs font-semibold tracking-[0.3em] text-purple-400 uppercase">Your Personal Station</span>
        </div>
        <h1 className="fade-in-up-delay-1 text-6xl font-black mb-3 tracking-tight">
          <span className="shimmer-text">PR</span>
        </h1>
        <p className="fade-in-up-delay-2 text-xl font-light text-white/70 mb-12 leading-relaxed">
          AI-curated music & stories,<br />
          <em>just for you</em>
        </p>

        {/* Form */}
        <form onSubmit={handleSubmit} className="fade-in-up-delay-3 space-y-5">
          <div className="relative">
            <div
              className={`absolute inset-0 rounded-2xl transition-all duration-300 ${
                isFocused
                  ? 'bg-gradient-to-r from-violet-600/30 to-purple-600/30 blur-sm scale-105'
                  : 'bg-transparent'
              }`}
            />
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              placeholder="What's your name?"
              maxLength={50}
              className={`relative w-full px-6 py-4 text-center text-lg font-medium text-white placeholder-white/30 bg-white/5 border-2 rounded-2xl outline-none transition-all duration-300 ${
                isFocused
                  ? 'border-purple-500 bg-white/8'
                  : 'border-white/10 hover:border-white/20'
              }`}
              autoFocus
            />
          </div>

          <button
            type="submit"
            disabled={!name.trim()}
            className={`w-full py-4 text-lg font-bold rounded-2xl transition-all duration-300 ${
              name.trim()
                ? 'bg-gradient-to-r from-violet-600 to-purple-600 text-white hover:from-violet-500 hover:to-purple-500 glow-purple-sm hover:scale-[1.02] active:scale-[0.98]'
                : 'bg-white/5 text-white/30 cursor-not-allowed border border-white/10'
            }`}
          >
            {name.trim() ? `Start Listening, ${name.trim().split(' ')[0]}` : 'Tune In →'}
          </button>
        </form>

        {/* Footer */}
        <p className="mt-12 text-white/20 text-xs tracking-wider">
          <a href="https://shakespeare.diy" target="_blank" rel="noopener noreferrer" className="hover:text-purple-400 transition-colors">
            Vibed with Shakespeare
          </a>
        </p>
      </div>
    </div>
  );
}
