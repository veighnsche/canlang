use time::{Date,Month,OffsetDateTime,format_description::well_known::Rfc3339};
fn date(s:&str)->Result<(),String>{
 let b=s.as_bytes();
 if b.len()!=10 || b[4]!=b'-' || b[7]!=b'-' || ![0..4,5..7,8..10].iter().all(|r|b[r.clone()].iter().all(u8::is_ascii_digit)){return Err("shape".into())}
 let y=s[0..4].parse::<i32>().unwrap();
 if y==0{return Err("year".into())}
 Date::from_calendar_date(y,Month::try_from(s[5..7].parse::<u8>().unwrap()).map_err(|e|e.to_string())?,s[8..10].parse().unwrap()).map(|_|()).map_err(|e|e.to_string())
}
fn adapted(s:&str)->Result<i128,String>{
 let b=s.as_bytes();
 if b.len()<20 || b[4]!=b'-'||b[7]!=b'-'||!matches!(b[10],b'T'|b't')||b[13]!=b':'||b[16]!=b':' || ![0..4,5..7,8..10,11..13,14..16,17..19].iter().all(|r|b[r.clone()].iter().all(u8::is_ascii_digit)){return Err("shape".into())}
 if &s[..4]=="0000"{return Err("year".into())}
 if &s[17..19]=="60"{return Err("leap second".into())}
 let mut normalized=s[..19].to_owned();let mut rest=&s[19..];
 if let Some(f)=rest.strip_prefix('.'){
  let n=f.bytes().take_while(u8::is_ascii_digit).count();
  if n==0{return Err("empty fraction".into())}
  if n>3&&!f[3..n].bytes().all(|b|b==b'0'){return Err("sub-ms".into())}
  normalized.push('.');normalized.push_str(&f[..n.min(3)]);rest=&f[n..];
 }
 if rest.eq_ignore_ascii_case("z"){normalized.push('Z')}else{
  let z=rest.as_bytes();
  if z.len()!=6||!matches!(z[0],b'+'|b'-')||z[3]!=b':'||!z[1..3].iter().all(u8::is_ascii_digit)||!z[4..6].iter().all(u8::is_ascii_digit){return Err("zone".into())}
  normalized.push_str(rest);
 }
 let dt=OffsetDateTime::parse(&normalized,&Rfc3339).map_err(|e|e.to_string())?;
 let ms=dt.unix_timestamp_nanos()/1_000_000;
 if !(-62_135_596_800_000..=253_402_300_799_999).contains(&ms){return Err("instant range".into())}Ok(ms)
}
fn main(){for line in std::io::stdin().lines(){let line=line.unwrap();let mut f=line.splitn(3,'\t');let id=f.next().unwrap();let kind=f.next().unwrap();let hex=f.next().unwrap();let decoded=String::from_utf8((0..hex.len()).step_by(2).map(|i|u8::from_str_radix(&hex[i..i+2],16).unwrap()).collect()).unwrap();let s=decoded.as_str();if kind=="date"{println!("{id}\tdate\t{:?}",date(s));}else{let raw=OffsetDateTime::parse(s,&Rfc3339).map(|d|d.unix_timestamp_nanos());println!("{id}\tprimitive_nanos\t{raw:?}\tadapted_ms\t{:?}",adapted(s));}}}
