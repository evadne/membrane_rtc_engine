defmodule Membrane.RTC.Engine.Endpoint.DistributedSink do
  @moduledoc """
  An Endpoint responsible for communicatiing with WebRTC peer.

  It is responsible for sending and receiving media tracks from other WebRTC peer (e.g. web browser).
  """
  use Membrane.Sink
  import Membrane.RTC.Utils

  alias Membrane.RTC.Engine
  alias Membrane.RTC.Engine.Endpoint.Distribution

  def_options twin_node: [
                spec: Node.t()
              ],
              pair_id: [
                spec: binary()
              ]

  def_input_pad :input,
    demand_unit: :buffers,
    caps: :any,
    availability: :on_request

  @impl true
  def handle_init(opts) do
    state = %{
      twin_node: opts.twin_node,
      pair_id: opts.pair_id,
      tracks_from_twin: %{}
    }

    :yes =
      my_global_name(state)
      |> :global.register_name(self())

    {:ok, state}
  end

  @impl true
  def handle_prepared_to_playing(_ctx, state) do
    twin_global_name(state)
    |> Distribution.Utils.match_with_twin()
    |> case do
      {:ok, twin} -> {:ok, Map.put(state, :twin, twin)}
      {:error, reason} -> {{:error, reason}, state}
    end
  end

  @impl true
  def handle_pad_added(Pad.ref(:input, track_id) = pad, _ctx, state) do
    send(state.twin, {:track_from_twin_ready, track_id})
    {:ok, state}
  end

  @impl true
  def handle_write(Pad.ref(:input, _track_id) = pad, payload, _ctx, state) do
    # maybe add sending demands
    send(state.twin, {:buffer_from_twin, pad, payload})
    {:ok, state}
  end

  @impl true
  def handle_caps(pad, caps, ctx, state) do
    send(state.twin, {:caps_from_twin, pad, caps})
    {:ok, state}
  end

  @impl true
  def handle_event(pad, event, _ctx, state) do
    send(state.twin, {:event_from_twin, pad, event})
    {:ok, state}
  end

  @impl true
  def handle_shutdown(_reason, state) do
    my_global_name(state)
    |> :global.unregister_name()

    :ok
  end

  @impl true
  def handle_other({:twin, twin}, _ctx, state), do: {:ok, state}

  @impl true
  def handle_other({:demand_from_twin, pad, size, _unit}, ctx, state) do
    actions = maybe_do_action(:demand, reverse_pad(pad), size, ctx)

    {{:ok, actions}, state}
  end

  @impl true
  def handle_other({:new_tracks, tracks}, _ctx, state) do
    send(state.twin, {:new_tracks_from_twin, tracks})

    subscriptions = Enum.map(tracks, &{&1.id, :rtp})
    new_tracks = Map.new(tracks, &{&1.id, &1})

    {{:ok, notify: {:subscribe, subscriptions}}, state}
  end

  @impl true
  def handle_other({:remove_tracks, tracks}, _ctx, state) do
    send(state.twin, {:remove_tracks_from_twin, tracks})
    {:ok, state}
  end

  @impl true
  def handle_other({:display_manager, _display_manager}, _ctx, state) do
    {:ok, state}
  end

  @impl true
  def handle_other({:event_from_twin, pad, event}, ctx, state) do
    actions = maybe_do_action(:event, reverse_pad(pad), event, ctx)
    {{:ok, actions}, state}
  end

  defp reverse_pad(Pad.ref(:input, track_id)), do: Pad.ref(:output, track_id)
  defp reverse_pad(Pad.ref(:output, track_id)), do: Pad.ref(:input, track_id)

  defp maybe_do_action(action_type, pad, value, ctx) do
    if ctx.playback_state == :playing and Map.has_key?(ctx.pads, pad),
      do: [{action_type, {pad, value}}],
      else: []
  end

  defp my_global_name(state),
    do: Distribution.Utils.distributed_sink_name(Node.self(), state.twin_node, state.pair_id)

  defp twin_global_name(state),
    do: Distribution.Utils.distributed_source_name(Node.self(), state.twin_node, state.pair_id)
end