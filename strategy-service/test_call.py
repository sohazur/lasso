"""Hello-world AgentPhone call.

- Reuses or creates a 'LAM Sales Test' agent.
- Cleans up any duplicate LAM agents from prior runs.
- Buys a fresh voice number if the agent doesn't have one.
- Places a call to MY_PHONE.
"""
import os
from dotenv import load_dotenv
from agentphone import AgentPhone

load_dotenv()

MY_PHONE = "+16502487860"

client = AgentPhone(api_key=os.getenv("AGENTPHONE_API_KEY"))

# 1. Find / consolidate LAM Sales Test agents.
agents = client.agents.list().data
lam_agents = [a for a in agents if a.name == "LAM Sales Test"]
print(f"Found {len(lam_agents)} LAM Sales Test agent(s)")

agent = lam_agents[0] if lam_agents else None
for dup in lam_agents[1:]:
    print(f"  deleting duplicate {dup.id}")
    client.agents.delete(dup.id)

if agent is None:
    print("Creating LAM Sales Test agent...")
    agent = client.agents.create(
        name="LAM Sales Test",
        voice_mode="hosted",
        system_prompt=(
            "You are Sarah, a warm sales associate at LAM, a women's wedding-wear boutique. "
            "You are calling Maryam to ask why she didn't complete her checkout. "
            "Open warmly: 'Hi Maryam, this is Sarah from LAM — I noticed you were checking out "
            "the Navy Silk Wrap Dress and didn't finish. Everything okay?' "
            "Listen, be helpful, do NOT immediately offer discounts."
        ),
    )
print(f"Agent: {agent.id}")

# 2. Ensure the agent has a voice-capable number. The pre-existing account
#    numbers were sms / shared-imessage, so we buy a fresh one.
voice_numbers = [n for n in (agent.numbers or []) if n.type not in ("sms", "shared-imessage")]
if voice_numbers:
    print(f"Agent already has a voice number: {voice_numbers[0].phone_number}")
else:
    print("Buying a voice number for the agent...")
    number = client.numbers.buy(country="US", agent_id=agent.id)
    print(f"Bought: {number.phone_number} (id={number.id}, type={number.type})")

# 3. Place the call.
call = client.calls.make(agent_id=agent.id, to_number=MY_PHONE)
print(f"Call placed: {call.id} — your phone should ring shortly.")
