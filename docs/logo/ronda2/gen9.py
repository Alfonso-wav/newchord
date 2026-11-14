import sys; sys.path.insert(0, r".")
from pix import build
m=lambda h: h+h[::-1]
mask=["..MMMMM....",".MM...MM...","MM.....MM..","MM..NN..MM.","MM..NN...MM","MM..NN..MM.","MM.....MM..",".MM...MM...","..MMMMM...."]
B=".#############"
half=(["."*14,"..........####",".......#######",".....#########","...###########","..############",B]
    +[".##"+r.replace('.','#') for r in mask]
    +[B,B,".############N",".############N",B,B,B,"d##d##d##ddddd","d"*14,"d"*14,"."*14,"."*14])
rows=[m(r) for r in half]
assert len(rows)==28 and all(len(r)==28 for r in rows), [len(r) for r in rows]
open('pixel-rows.txt','w').write('\n'.join(rows))
build('pixel-v9.svg',rows); build('pixel-v9-oscuro.svg',rows,bg='#070907')
