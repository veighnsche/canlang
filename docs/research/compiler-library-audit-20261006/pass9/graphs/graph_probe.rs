use std::{collections::HashSet,time::Instant,hint::black_box};
use petgraph::{graph::DiGraph,algo::kosaraju_scc};
type G=Vec<Vec<usize>>;
// Shared iterative reach scanner; explicit root-close vs any-repeat policies differ.
fn closes(g:&G, root:usize)->usize {let mut stack=vec![root];let mut seen=HashSet::from([root]);let mut n=0;while let Some(v)=stack.pop(){for &w in &g[v]{if w==root{n+=1}else if seen.insert(w){stack.push(w)}}}n}
fn reaches(g:&G,root:usize)->bool {let mut v=root;let mut seen=HashSet::from([root]);while let Some(&w)=g[v].first(){if !seen.insert(w){return true}v=w}false}
#[derive(Debug,PartialEq,Eq)] struct Witness{path:Vec<usize>,edge:(usize,usize,usize)}
fn calls(g:&G,roots:&[usize],allowed:Option<&[bool]>)->Vec<Witness>{let mut reported=HashSet::new();let mut out=vec![];for &root in roots{if allowed.is_some_and(|a|!a[root]){continue}let mut stack=vec![(root,vec![root])];let mut seen=HashSet::new();while let Some((v,path))=stack.pop(){for (i,&w) in g[v].iter().enumerate(){if w==root{let mut key=path.clone();key.sort();if reported.insert(key){let mut p=path.clone();p.push(root);out.push(Witness{path:p,edge:(v,w,i)})}continue}if seen.contains(&w)||path.contains(&w){continue}seen.insert(w);let mut p=path.clone();p.push(w);stack.push((w,p));}}}out}
// SCC adapter: retain graph's authored adjacency for diagnostic traversal.
fn scc(g:&G)->(Vec<bool>,Vec<bool>){let mut p=DiGraph::<(),()>::new();let ids:Vec<_>=(0..g.len()).map(|_|p.add_node(())).collect();for (v,ws) in g.iter().enumerate(){for &w in ws{p.add_edge(ids[v],ids[w],());}}let mut cyclic=vec![false;g.len()];for c in kosaraju_scc(&p){if c.len()>1 || c.first().is_some_and(|v|g[v.index()].contains(&v.index())){for v in c{cyclic[v.index()]=true}}}let mut reverse=vec![vec![];g.len()];for (v,ws) in g.iter().enumerate(){for &w in ws{reverse[w].push(v)}}let mut reach=cyclic.clone();let mut stack:Vec<_>=(0..g.len()).filter(|&v|cyclic[v]).collect();while let Some(v)=stack.pop(){for &w in &reverse[v]{if !reach[w]{reach[w]=true;stack.push(w)}}}(cyclic,reach)}
fn median(mut f:impl FnMut()->usize)->(u128,usize){let mut times=vec![];let mut n=0;for _ in 0..9{let t=Instant::now();n=black_box(f());times.push(t.elapsed().as_nanos())}times.sort();(times[4],n)}
fn main(){
// Fixed expectations are declared independently of either implementation.
let fixtures:Vec<(&str,G,Vec<bool>,Vec<bool>)>=vec![
("acyclic",vec![vec![1],vec![2],vec![]],vec![false;3],vec![false;3]),
("upstream",vec![vec![1],vec![2],vec![1]],vec![false,true,true],vec![true;3]),
("independent",vec![vec![0],vec![2],vec![1],vec![]],vec![true,true,true,false],vec![true,true,true,false]),
("duplicate",vec![vec![1,1],vec![0,0]],vec![true;2],vec![true;2]),
("overlap",vec![vec![1,2],vec![0],vec![0]],vec![true;3],vec![true;3]),
("diamond",vec![vec![1,2],vec![3],vec![3],vec![0]],vec![true;4],vec![true;4])];
for (name,g,c,r) in fixtures {let got=scc(&g);assert_eq!(got,(c.clone(),r.clone()));for v in 0..g.len(){assert_eq!(closes(&g,v)>0,c[v]);if g.iter().all(|a|a.len()<=1){assert_eq!(reaches(&g,v),r[v]);}}let roots:Vec<_>=(0..g.len()).collect();assert_eq!(calls(&g,&roots,None),calls(&g,&roots,Some(&c)));println!("FIXED {name} cyclic={c:?} reaching={r:?} calls={:?}",calls(&g,&roots,None));}
assert_eq!(closes(&vec![vec![1,1],vec![0,0]],0),2);
let g=vec![vec![1,2],vec![0],vec![0]];
assert_eq!(calls(&g,&[0,1,2],None),vec![Witness{path:vec![0,2,0],edge:(2,0,0)},Witness{path:vec![0,1,0],edge:(1,0,0)}]);
assert_eq!(calls(&g,&[2,1,0],None),vec![Witness{path:vec![2,0,2],edge:(0,2,1)},Witness{path:vec![1,0,1],edge:(0,1,0)}]);
// Exhaustively compare SCC gate with unchanged call policy, all 3-node directed graphs, both root orders.
for bits in 0..512 {let mut g=vec![vec![];3];for v in 0..3{for w in 0..3{if bits&(1<<(v*3+w))!=0{g[v].push(w)}}}let (c,_)=scc(&g);for roots in [&[0,1,2][..],&[2,1,0][..]]{assert_eq!(calls(&g,roots,None),calls(&g,roots,Some(&c)));}}println!("EXHAUSTIVE 512 graphs x 2 root orders: exact witness/closing-edge/order parity");
let n=1000;let mut chain=vec![vec![];n];for v in 0..n-1{chain[v].push(v+1)}let mut upstream=chain.clone();upstream[n-1].push(n-2);let mut independent=vec![vec![];n];for v in 0..n{independent[v].push(if v%2==0{v+1}else{v-1})}let mut fanout=vec![vec![];n];fanout[0]=(1..n).collect();let mut sparse=vec![vec![];n];for v in 0..n {if v+1<n{sparse[v].push(v+1)}if v+7<n{sparse[v].push(v+7)}}
for (name,g) in [("chain_acyclic",chain),("sparse_acyclic",sparse),("independent_cycles",independent),("highfanout",fanout),("upstream_chain_cycle",upstream)] {let roots:Vec<_>=(0..n).filter(|&v|!g[v].is_empty()).collect();let direct=median(||(0..n).filter(|&v|closes(&g,v)>0).count());let member=median(||scc(&g).0.iter().filter(|&&v|v).count());let call=median(||calls(&g,&roots,None).len());let gated=median(||{let(c,_)=scc(&g);calls(&g,&roots,Some(&c)).len()});assert_eq!(direct.1,member.1);assert_eq!(call.1,gated.1);let reach=if g.iter().all(|a|a.len()<=1){Some(median(||(0..n).filter(|&v|reaches(&g,v)).count()))}else{None};println!("BENCH {name} vertices={n} edges={} membership_direct_ns={} scc_build_membership_reverse_ns={} call_direct_ns={} call_scc_gate_ns={} cyclic={} call_diags={} reach_direct={reach:?}",g.iter().map(Vec::len).sum::<usize>(),direct.0,member.0,call.0,gated.0,direct.1,call.1);}
}
