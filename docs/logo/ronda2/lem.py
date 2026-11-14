import math
def lem(W=28,H=8,a=10.6,sy=1.25,w=0.95):
    pts=[]
    for i in range(2000):
        t=2*math.pi*i/2000; d=1+math.sin(t)**2
        pts.append((a*math.cos(t)/d, sy*a*math.sin(t)*math.cos(t)/d))
    cx=(W-1)/2; cy=(H-1)/2; rows=[]
    for y in range(H):
        r=''
        for x in range(W):
            px,py=x-cx,y-cy
            r+='M' if min((px-u)**2+(py-v)**2 for u,v in pts)<w*w else '#'
        rows.append(r)
    return rows
if __name__=='__main__':
    for sy in (1.2,1.4):
        print(sy); print('\n'.join(lem(sy=sy)))
