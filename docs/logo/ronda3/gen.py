import math, sys
G='#5fff5f'; K='#070907'; D='#1c6b2a'
def lem(cx,cy,a,sy,n=96):
    p=[]
    for i in range(n):
        t=2*math.pi*i/n; d=1+math.sin(t)**2
        p.append((cx+a*math.cos(t)/d, cy+sy*a*math.sin(t)*math.cos(t)/d))
    return 'M'+' L'.join(f'{x:.1f} {y:.1f}' for x,y in p)+'Z'
def svg(name, a=78, sy=1.7, sw=36, pup=11, nose=None, bg=None):
    cy=112; ex=128-a*0.59  # centro aproximado de cada bucle
    o=[f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" role="img"><title>newchord</title>']
    if bg: o.append(f'<rect width="256" height="256" fill="{bg}"/>')
    o.append(f'<path fill="{G}" d="M36 220 V132 A92 92 0 0 1 220 132 V220 Z"/>')
    o.append(f'<path fill="none" stroke="{K}" stroke-width="{sw}" stroke-linejoin="round" d="{lem(128,cy,a,sy)}"/>')
    for x in (ex, 256-ex):
        o.append(f'<circle fill="{K}" cx="{x:.1f}" cy="{cy}" r="{pup}"/><circle fill="{G}" cx="{x+4:.1f}" cy="{cy-4}" r="3.5"/>')
    o.append(nose or NOSES['ovalo'])
    o.append(f'<path fill="{D}" d="M6 244 C6 214 30 204 64 206 C90 207 108 214 128 214 C148 214 166 207 192 206 C226 204 250 214 250 244 Z"/>')
    paws=[(c+dx) for c in (82,174) for dx in (-17,0,17)]
    o.append('<g fill="'+D+'">'+''.join(f'<circle cx="{x}" cy="214" r="17"/>' for x in paws)+'</g>')
    o.append('<g fill="'+G+'">'+''.join(f'<circle cx="{x}" cy="214" r="12"/>' for x in paws)+'</g>')
    o.append('</svg>'); open(name,'w').write('\n'.join(o))
HL=f'<ellipse fill="{G}" cx="116" cy="167" rx="9" ry="5.5"/>'
def estrella():
    c=''.join(f'<circle cx="{128+19*math.cos(2*math.pi*i/10-math.pi/2):.1f}" cy="{179+17*math.sin(2*math.pi*i/10-math.pi/2):.1f}" r="8.5"/>' for i in range(10))
    return f'<g fill="{K}">{c}<circle cx="128" cy="179" r="18"/></g><ellipse fill="{G}" cx="121" cy="173" rx="6" ry="4"/>'
NOSES={
 'ovalo': f'<ellipse fill="{K}" cx="128" cy="176" rx="31" ry="23"/>'+HL,
 'estrella': estrella(),
 'corazon': f'<path fill="{K}" d="M128 204 C108 202 94 188 94 174 C94 160 108 156 128 156 C148 156 162 160 162 174 C162 188 148 202 128 204 Z"/><ellipse fill="{G}" cx="114" cy="166" rx="9" ry="5"/>',
 'orificios': f'<ellipse fill="{K}" cx="128" cy="178" rx="36" ry="24"/><ellipse fill="{G}" cx="113" cy="184" rx="6" ry="8" transform="rotate(-25 113 184)"/><ellipse fill="{G}" cx="143" cy="184" rx="6" ry="8" transform="rotate(25 143 184)"/>',
 'hocico': f'<ellipse fill="{G}" stroke="{D}" stroke-width="6" cx="128" cy="184" rx="42" ry="22"/><ellipse fill="{K}" cx="128" cy="170" rx="22" ry="15"/><ellipse fill="{G}" cx="120" cy="165" rx="6" ry="3.5"/>',
 'boton': f'<circle fill="{K}" cx="128" cy="180" r="27"/><circle fill="{G}" cx="117" cy="170" r="7"/>',
}
for n in NOSES:
    svg(f'nariz-{n}.svg',a=68,sy=1.2,sw=31,pup=10,nose=NOSES[n])
for tag,kw in (('final',dict(a=68,sy=1.2,sw=31,pup=10)),):
    svg(f'topo-{tag}.svg',**kw); svg(f'topo-{tag}-oscuro.svg',bg=K,**kw)
