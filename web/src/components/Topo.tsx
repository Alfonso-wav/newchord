// Topo saliendo del hoyo (tira de 8 fotogramas en assets/topos/topo-hoyo.png, compartida con el panel).
export function Topo({ className = '' }: { className?: string }) {
  return <span className={`topo ${className}`} aria-hidden />;
}
