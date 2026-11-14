import sys; sys.path.insert(0, r".")
from pix import build
m=lambda h: h+h[::-1]
claws=''.join('#' if i in (2,4,6,13,15,17) else 'd' for i in range(20))
top=["....................",".......######.......",".....##########.....","...##############...","..################..",".##################."]
bot=[".##################.",".#######NNNN#######.",".########NN########.",".##################.",".##################.",claws,"d"*20,"."*20]
# v4: ∞ de trazo fino
v4=top+[m(".###MMM###"),m(".##M###M##"),m(".#M##N##MM"),m(".#M##N##MM"),m(".##M###M##"),m(".###MMM###")]+bot
# v5: ∞ de trazo doble (más peso de antifaz)
v5=top+[m(".##MMMMM##"),m(".#MMMMMMMM"),m(".MM##NMMMM"),m(".MM##NMMMM"),m(".#MMMMMMMM"),m(".##MMMMM##")]+bot
for t,v in (('v4',v4),('v5',v5)):
    assert all(len(r)==20 for r in v),t
    build(f'pixel-{t}.svg',v); build(f'pixel-{t}-oscuro.svg',v,bg='#070907')
v6=top+[m(".###MMMM##"),m(".##M####M#"),m(".##M##N##M"),m(".##M##N##M"),m(".##M####M#"),m(".###MMMM##")]+bot
build('pixel-v6.svg',v6); build('pixel-v6-oscuro.svg',v6,bg='#070907')
mask=["..MMMMM....",".MMMMMMM...","MM.....MM..","MM..NN..MMM","MM..NN..MMM","MM.....MM..",".MMMMMMM...","..MMMMM...."]
B=".#############"
v7=[m(r) for r in ["."*14,"..........####",".......#######",".....#########","...###########","..############",B,B]
    +[".##"+r.replace('.','#') for r in mask]
    +[B,".##########NNN",".###########NN",B,B,B,B,"d##d##d##ddddd","d"*14,"d"*14,"."*14,"."*14]]
assert len(v7)==28 and all(len(r)==28 for r in v7)
build('pixel-v7.svg',v7); build('pixel-v7-oscuro.svg',v7,bg='#070907')
mask=["..MMMMM....",".MMMMMMM...","MM.....MM..","MM..NN...MM","MM..NN...MM","MM.....MM..",".MMMMMMM...","..MMMMM...."]
v8=[m(r) for r in ["."*14,"..........####",".......#######",".....#########","...###########","..############",B,B]
    +[".##"+r.replace('.','#') for r in mask]
    +[B,B,"............NN","............NN",B,B,B,"d##d##d##ddddd","d"*14,"d"*14,"."*14,"."*14]]
v8=[r if 'N' not in r[:14] or i<16 else r[:14].replace('N','#')+r[14:] for i,r in enumerate(v8)]
v8=[r.replace('.','#') if 18<=i<=19 else r for i,r in enumerate(v8)]
v8=[ ('.'+r[1:-1]+'.') if 18<=i<=19 else r for i,r in enumerate(v8)]
assert len(v8)==28 and all(len(r)==28 for r in v8)
build('pixel-v8.svg',v8); build('pixel-v8-oscuro.svg',v8,bg='#070907')
print('\n'.join(v8[16:21]))
