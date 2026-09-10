import * as React from "react"

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  // Hydration-stable: SSR and first client paint both report `false`, the real
  // value lands right after paint via rAF (eslint-plugin-react-hooks v7 —
  // no synchronous setState inside the effect body).
  const [isMobile, setIsMobile] = React.useState<boolean>(false)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    mql.addEventListener("change", onChange)
    const raf = requestAnimationFrame(onChange)
    return () => {
      mql.removeEventListener("change", onChange)
      cancelAnimationFrame(raf)
    }
  }, [])

  return isMobile
}
