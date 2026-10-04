"""Conditional 24-month ownership arithmetic, not quotes or observed costs."""
import json
from pathlib import Path
HORIZON=24
profiles={
 'P_low_support':dict(setup_tech_h=8,setup_staff_h=6,inc_setup_tech_h=2,inc_setup_staff_h=2,overlap_months=1,can_tech_h=1,inc_tech_h=.5,can_staff_h=1,inc_staff_h=3,tech_rate=100,staff_rate=35,can_platform=50,can_provider=10,inc_extra_provider=0),
 'P_high_support':dict(setup_tech_h=24,setup_staff_h=16,inc_setup_tech_h=4,inc_setup_staff_h=4,overlap_months=2,can_tech_h=4,inc_tech_h=1,can_staff_h=2,inc_staff_h=4,tech_rate=100,staff_rate=35,can_platform=100,can_provider=25,inc_extra_provider=0),
 'W_low_support':dict(setup_tech_h=60,setup_staff_h=20,inc_setup_tech_h=12,inc_setup_staff_h=8,overlap_months=2,can_tech_h=4,inc_tech_h=2,can_staff_h=3,inc_staff_h=8,tech_rate=100,staff_rate=35,can_platform=100,can_provider=50,inc_extra_provider=25),
 'W_high_support':dict(setup_tech_h=160,setup_staff_h=60,inc_setup_tech_h=24,inc_setup_staff_h=16,overlap_months=4,can_tech_h=12,inc_tech_h=3,can_staff_h=6,inc_staff_h=12,tech_rate=100,staff_rate=35,can_platform=250,can_provider=100,inc_extra_provider=25),
}
result={}
for name,p in profiles.items():
 can_setup=p['setup_tech_h']*p['tech_rate']+p['setup_staff_h']*p['staff_rate']
 inc_setup=p['inc_setup_tech_h']*p['tech_rate']+p['inc_setup_staff_h']*p['staff_rate']
 delta_setup=can_setup-inc_setup
 can_month=p['can_tech_h']*p['tech_rate']+p['can_staff_h']*p['staff_rate']+p['can_platform']+p['can_provider']
 inc_month=p['inc_tech_h']*p['tech_rate']+p['inc_staff_h']*p['staff_rate']+p['inc_extra_provider']
 delta_month=can_month-inc_month
 break_even=(delta_setup+HORIZON*delta_month)/(HORIZON-p['overlap_months'])
 savings={str(subscription):round((HORIZON-p['overlap_months'])*subscription-delta_setup-HORIZON*delta_month,2) for subscription in (150,450,900,1500)}
 result[name]={'assumptions':p,'can_setup':can_setup,'incumbent_future_setup':inc_setup,'can_month_excluding_retained_subs':can_month,'incumbent_month_excluding_avoidable_subs':inc_month,'incremental_setup':delta_setup,'incremental_month':delta_month,'avoidable_subscription_break_even_per_month':round(break_even,2),'24_month_net_savings_by_avoidable_monthly_subscription':savings}
Path(__file__).with_name('results.json').write_text(json.dumps({'horizon_months':HORIZON,'currency':'USD scenario units; no exchange-rate claim','results':result},indent=2)+'\n')
print(json.dumps(result,indent=2))
